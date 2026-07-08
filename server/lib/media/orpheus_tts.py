#!/usr/bin/env python3
"""Local text-to-speech via Orpheus running on Ollama — the default backend for
Hive's generate_speech tool when the media backend is "Local (Ollama + MLX)".

Pipeline (the established orpheus-tts-local approach):
  1. Prompt the Orpheus GGUF model served by Ollama; it emits SNAC audio codes
     encoded as custom tokens in its text output.
  2. Parse those tokens back into SNAC codebook indices.
  3. Decode with the SNAC neural codec to a 24kHz waveform.
  4. Write a WAV to --out.

Contract matches flux_generate.py: JSON status on stdout on success; JSON
{"error": ...} on stderr + non-zero exit on failure, with actionable hints for
missing deps (snac/torch) or a missing Ollama model.
"""
import argparse
import json
import struct
import sys
import urllib.request


def fail(msg, code=3):
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(code)


# Orpheus emits tokens like <custom_token_1234>; codes are offset by 10 and by
# 4096 per SNAC layer position (7 codes per frame across 3 layers).
CUSTOM_TOKEN_PREFIX = "<custom_token_"


def parse_snac_codes(text):
    """Parse <custom_token_N> into SNAC codebook ids. Orpheus encodes the frame
    position into N: id = N - 10 - ((count % 7) * 4096), where count is the number
    of codes ACCEPTED so far. Leading control tokens (start-of-audio markers) and
    any stray token compute out of the valid [0,4095] range and are skipped
    WITHOUT advancing count, which both strips the preamble and preserves the
    7-per-frame alignment of the real audio stream."""
    codes = []
    count = 0
    pos = 0
    while True:
        start = text.find(CUSTOM_TOKEN_PREFIX, pos)
        if start == -1:
            break
        end = text.find(">", start)
        if end == -1:
            break
        try:
            n = int(text[start + len(CUSTOM_TOKEN_PREFIX):end])
            cid = n - 10 - ((count % 7) * 4096)
            if 0 <= cid <= 4095:
                codes.append(cid)
                count += 1
        except ValueError:
            pass
        pos = end + 1
    return codes


def redistribute_codes(codes):
    """Group the parsed ids into SNAC's three hierarchical layers by frame
    position: layer1←pos0, layer2←pos1,4, layer3←pos2,3,5,6 (7 codes per frame)."""
    import torch  # local import so a missing dep is reported clearly below
    layer_1, layer_2, layer_3 = [], [], []
    n_frames = len(codes) // 7
    for i in range(n_frames):
        base = 7 * i
        layer_1.append(codes[base])
        layer_2.append(codes[base + 1])
        layer_3.append(codes[base + 2])
        layer_3.append(codes[base + 3])
        layer_2.append(codes[base + 4])
        layer_3.append(codes[base + 5])
        layer_3.append(codes[base + 6])
    return [
        torch.tensor(layer_1).unsqueeze(0),
        torch.tensor(layer_2).unsqueeze(0),
        torch.tensor(layer_3).unsqueeze(0),
    ]


def write_wav(path, samples, rate=24000):
    # samples: 1-D float array in [-1, 1]. Write a minimal 16-bit PCM WAV.
    pcm = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples)
    with open(path, "wb") as f:
        data_len = len(pcm)
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + data_len))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", data_len))
        f.write(pcm)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="orpheus", help="Ollama model tag for Orpheus")
    ap.add_argument("--voice", default="tara")
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    args = ap.parse_args()

    prompt = f"{args.voice}: {args.text}"
    body = json.dumps({
        "model": args.model,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.6, "top_p": 0.9, "num_predict": 4096},
    }).encode()
    url = args.ollama.rstrip("/") + "/api/generate"
    try:
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode())
    except Exception as e:  # noqa: BLE001
        fail(f"Could not reach Ollama at {args.ollama} for model '{args.model}' ({e}). "
             f"Pull/serve the Orpheus GGUF model in Ollama and set media_tts_model to its tag.")

    codes = parse_snac_codes(payload.get("response", ""))
    if len(codes) < 7:
        fail("Orpheus returned no audio tokens — confirm the model tag is the "
             "Orpheus GGUF (it must emit <custom_token_*> codes), not a plain chat model.", code=4)

    try:
        import torch  # noqa: F401
        from snac import SNAC
    except Exception as e:  # noqa: BLE001
        fail(f"SNAC decoder deps missing ({e}). Install them: pip install snac torch")

    try:
        model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval()
        layers = redistribute_codes(codes)
        with torch.inference_mode():
            audio = model.decode(layers)
        samples = audio.squeeze().tolist()
        write_wav(args.out, samples)
    except Exception as e:  # noqa: BLE001
        fail(f"SNAC decode failed ({e}).", code=4)

    print(json.dumps({"ok": True, "out": args.out, "voice": args.voice, "frames": len(codes) // 7}))


if __name__ == "__main__":
    main()
