---
layout: guide
title: Build and run a pipeline
description: Create a multi-step workflow, pass original and previous outputs, use model and tool overrides, add parallel work, and inspect runs.
permalink: /docs/guides/pipeline/
section: Workflow how-to
previous_url: /docs/guides/first-colony/
previous_label: Run your first Colony
next_url: /docs/guides/schedules/
next_label: Schedule recurring work
---

A pipeline is best when the processing path is known in advance. Create and test each agent before composing them.

## Example: research, draft, and edit

Prepare three agents:

- Researcher with Web Search
- Writer with no external tools
- Editor with a precise prompt and low temperature

## Create the pipeline

1. Open **Pipelines → New Pipeline**.
2. Enter a name and description, or select **Use a template**.
3. Add the Research step.
4. Set Agent to Researcher.
5. Set Prompt Template:

```text
Research this request and return sourced findings:
{input}
```

6. Add the Draft step:

```text
Using the research below, draft the requested document.
Original request: {input}
Research: {prev}
```

7. Add the Edit step:

```text
Edit this draft for accuracy, clarity, and the requested format:
{prev}
```

8. Review **Input flow preview** and save.

## Understand variables

- `{input}` is always the original run input.
- `{prev}` is the output available from the preceding pipeline stage.
- A prompt can use both.

If neither appears, the step receives only its literal prompt.

## Advanced step options

Open the disclosure on a step to configure:

- **Model override:** use another model for this step without editing the agent.
- **Tool override:** an explicit list replacing the agent’s configured tools for this step.
- **Run in parallel:** consecutive parallel steps execute simultaneously.

Parallel steps must not depend on each other’s output. Hive runs consecutive parallel steps together; inspect Input Flow Preview to confirm what each receives.

## Validate before saving

The editor checks:

- pipeline name;
- at least one step;
- selected agents;
- usable models;
- nonempty prompts; and
- the current step flow.

Fix every “needs attention” indicator.

## Run and inspect

1. Select **Run** on the pipeline.
2. Enter representative input.
3. Watch step status, timing, and output.
4. Confirm each stage received the intended input.
5. Inspect the final output and any failure.

Test empty, malformed, and large input before scheduling the pipeline. A pipeline schedule passes its prompt as `{input}` and stores the final step output as the run result.
