import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Zap, Trash2, Clock, XCircle, Loader2, Users, RefreshCw, ArrowLeft, Plus, Pencil, Search, Link2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../lib/utils';
import { AGENT_COLORS, sseToEntries, dbLogToEntries } from '../../lib/colonyUtils';
import { readSSEStream } from '../../lib/streamParser';
import {
  ArtifactsPanel, ArtifactViewerModal, ColonyCard, ColonyLiveView, ColonyMemoryPanel,
  InsightsPanel, PerformanceStrip, TeamConfigModal,
} from './components';
import { BOARD_LANES, PROVIDER_LABEL, STATUS_DOT, STATUS_TEXT, boardCardToGoal, flattenModels, preferredFlatModel, runLabel } from './helpers';

export function useColonyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  // /colony · /colony/:teamId · /colony/:teamId/run/:runId
  const pathMatch = location.pathname.match(/^\/colony(?:\/([^/]+))?(?:\/run\/([^/]+))?\/?$/);
  const teamId = pathMatch?.[1] || null;
  const runId = pathMatch?.[2] || null;
  const selectedId = runId;

  // ── Colony (team) state ─────────────────────────────────────────────────────
  const [teams, setTeams] = useState([]);
  const [recipes, setRecipes] = useState([]);
  const [teamModal, setTeamModal] = useState(null); // null | 'new' | team object
  const [artifactViewer, setArtifactViewer] = useState(null); // { runId, path } | null
  const [overview, setOverview] = useState(null);   // { team, runs, crew, artifacts, performance, repo }
  const [loadingOverview, setLoadingOverview] = useState(false);

  // ── Run-launch state (lives on the colony page) ─────────────────────────────
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [groupedModels, setGroupedModels] = useState({});
  const [modelPlan, setModelPlan] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [triggerEvents, setTriggerEvents] = useState(['issue', 'task']);
  const [webhooks, setWebhooks] = useState([]);
  const [selectedWebhookId, setSelectedWebhookId] = useState('');
  const [commentToken, setCommentToken] = useState('@hive');
  const [projectBoard, setProjectBoard] = useState({ source: null, lanes: BOARD_LANES.map(l => l.id), cards: [] });
  const [selectedBoardCardId, setSelectedBoardCardId] = useState(null);
  const [boardSearch, setBoardSearch] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');

  // ── Run display state ───────────────────────────────────────────────────────
  const [colonies, setColonies] = useState([]);          // flat run list (status bookkeeping)
  const [loadedColony, setLoadedColony] = useState(null); // full run data inc. log
  const [loadingColony, setLoadingColony] = useState(false);

  // Live run state
  const [activeColonyId, _setActiveColonyId] = useState(null);
  // Ref mirror, written synchronously alongside the state, so the resume effect
  // can check "already streaming" without activeColonyId in its deps (which
  // caused the effect to abort the stream it had just opened).
  const activeColonyIdRef = useRef(null);
  const setActiveColonyId = useCallback((id) => {
    activeColonyIdRef.current = id;
    _setActiveColonyId(id);
  }, []);
  const [liveLog, setLiveLog] = useState([]);
  const [liveAgentColorMap, setLiveAgentColorMap] = useState({});
  const [streamingByAgent, setStreamingByAgent] = useState({});
  const [livePlan, setLivePlan] = useState(null);
  const [liveBlockers, setLiveBlockers] = useState([]);
  const [livePrUrl, setLivePrUrl] = useState(null);
  const colorIndexRef = useRef(0);
  const streamAbortRef = useRef(null);

  // ── Token batching ──────────────────────────────────────────────────────────
  const tokenBufRef = useRef({});
  const tokenFlushRef = useRef(null);
  const flushTokens = useCallback(() => {
    tokenFlushRef.current = null;
    const pending = tokenBufRef.current;
    tokenBufRef.current = {};
    const names = Object.keys(pending);
    if (names.length === 0) return;
    setStreamingByAgent(prev => {
      const next = { ...prev };
      for (const name of names) {
        const ex = next[name] || { content: '', thinking: '' };
        next[name] = {
          content: ex.content + pending[name].content,
          thinking: ex.thinking + pending[name].thinking,
        };
      }
      return next;
    });
  }, []);
  const queueToken = useCallback((agent, kind, delta) => {
    if (!delta) return;
    const buf = tokenBufRef.current;
    const a = buf[agent] || (buf[agent] = { content: '', thinking: '' });
    a[kind === 'thinking' ? 'thinking' : 'content'] += delta;
    if (!tokenFlushRef.current) tokenFlushRef.current = setTimeout(flushTokens, 80);
  }, [flushTokens]);
  const clearStreaming = useCallback((agent = null) => {
    if (agent) {
      delete tokenBufRef.current[agent];
      setStreamingByAgent(prev => {
        if (!prev[agent]) return prev;
        const next = { ...prev };
        delete next[agent];
        return next;
      });
    } else {
      tokenBufRef.current = {};
      if (tokenFlushRef.current) { clearTimeout(tokenFlushRef.current); tokenFlushRef.current = null; }
      setStreamingByAgent({});
    }
  }, []);

  // ── Data loading ────────────────────────────────────────────────────────────
  useEffect(() => {
    api.getColonyTeams().then(setTeams).catch(() => {});
    api.getColonies().then(setColonies).catch(() => {});
    api.getColonyRecipes().then(setRecipes).catch(() => {});
    api.getWebhooks().then(rows => setWebhooks(rows || [])).catch(() => {});
    api.getAllModels().then(g => setGroupedModels(g || {})).catch(() => {
      api.getModels().then(m => {
        setGroupedModels({ ollama: m.map(x => ({ id: x.name, provider: 'ollama', name: x.name })) });
      }).catch(() => {});
    });
  }, []);

  const cloudEnabled = !!overview?.team?.cloud_enabled;

  // Selectable model list follows the team's cloud setting.
  useEffect(() => {
    const flat = flattenModels(groupedModels, cloudEnabled);
    setModels(flat);
    setModel(prev => (flat.some(m => m.id === prev) ? prev : preferredFlatModel(flat)));
    setModelPlan(null);
  }, [cloudEnabled, groupedModels]);

  const reloadOverview = useCallback(() => {
    if (!teamId) return;
    api.getColonyTeam(teamId).then(setOverview).catch(() => setOverview(null));
  }, [teamId]);

  // Load the colony overview + board when entering a colony page; refresh the
  // teams list (and overview) when navigating back from a run.
  useEffect(() => {
    if (!teamId) {
      setOverview(null);
      api.getColonyTeams().then(setTeams).catch(() => {});
      return;
    }
    if (!runId) {
      setLoadingOverview(true);
      api.getColonyTeam(teamId)
        .then(setOverview)
        .catch(() => setOverview(null))
        .finally(() => setLoadingOverview(false));
      api.getColonyTeamBoard(teamId).then(setProjectBoard).catch(() => {});
      setSelectedBoardCardId(null);
      setBoardSearch('');
      setLaunchError('');
    }
  }, [teamId, runId]);

  const selectedBoardCard = useMemo(
    () => (projectBoard.cards || []).find(card => card.id === selectedBoardCardId) || null,
    [projectBoard.cards, selectedBoardCardId],
  );
  const visibleBoardCards = useMemo(() => {
    const q = boardSearch.trim().toLowerCase();
    const cards = projectBoard.cards || [];
    const filteredCards = q
      ? cards.filter(card => `${card.title || ''} ${card.number || ''} ${card.status_label || ''}`.toLowerCase().includes(q))
      : cards;
    return filteredCards.slice(0, 8);
  }, [boardSearch, projectBoard.cards]);

  const handleProposeModels = async () => {
    if (!overview?.team) return;
    setProposing(true);
    try {
      const res = await api.proposeColonyModels(overview.team.recipe_id, cloudEnabled);
      setModelPlan(res.model_plan || null);
    } catch {
      // leave plan unset; the single base model still launches the run
    } finally {
      setProposing(false);
    }
  };

  // ── SSE consumer (shared by launch + resume paths) ──────────────────────────
  const consumeStream = useCallback(async (response, knownColonyId = null, { fromLogEntries = false } = {}) => {
    let colonyId = knownColonyId;
    const agentNameMap = {};

    const processEvent = (event) => {
      if (event.type === 'colony_id') {
        colonyId = event.colonyId;
        setActiveColonyId(colonyId);
        return;
      }

      if (event.type === 'log_entry') {
        if (fromLogEntries && event.entry) {
          const converted = dbLogToEntries([event.entry], {});
          if (converted.length > 0) setLiveLog(prev => [...prev, ...converted]);
        }
        return;
      }

      if (event.type === 'token' && event.agent) {
        queueToken(event.agent, event.kind, event.delta);
        return;
      }

      if (event.type === 'plan_update' && event.plan) {
        setLivePlan(event.plan);
        return;
      }

      if (event.type === 'agent_ready' && event.agent?.name) {
        const agentName = event.agent.name;
        agentNameMap[event.agent.id] = agentName;
        setLiveAgentColorMap(prev => {
          if (prev[agentName]) return prev;
          const color = event.agent.avatar_color || AGENT_COLORS[colorIndexRef.current % AGENT_COLORS.length];
          colorIndexRef.current++;
          return { ...prev, [agentName]: color };
        });
      }

      const entries = fromLogEntries ? [] : sseToEntries(event, agentNameMap);
      if (entries.length > 0) setLiveLog(prev => [...prev, ...entries]);

      if (event.type === 'round_start' || event.type === 'orchestrator_message') {
        clearStreaming();
      }
      if (event.type === 'ws') {
        const m = event.msg || {};
        if (m.type === 'sub_tool_call' || m.type === 'tool_call') {
          if (m.subAgent) clearStreaming(m.subAgent);
        }
      }

      if (event.type === 'done' || event.type === 'error') {
        clearStreaming();
        const newStatus = event.type === 'done' ? (event.status || 'done') : 'error';
        if (colonyId) {
          setColonies(prev => prev.map(c => c.id === colonyId ? { ...c, status: newStatus } : c));
          setOverview(prev => prev ? {
            ...prev,
            runs: (prev.runs || []).map(r => r.id === colonyId ? { ...r, status: newStatus } : r),
          } : prev);
          api.getColony(colonyId).then(data => {
            setLoadedColony(prev => (prev?.id === colonyId || selectedId === colonyId ? data : prev));
          }).catch(() => {});
        }
        setActiveColonyId(null);
      }
    };

    try {
      for await (const event of readSSEStream(response)) processEvent(event);
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLiveLog(prev => [...prev, { type: 'error', content: e.message }]);
      }
    }
  }, [selectedId]);

  // Load full run detail when a run is opened. For running runs, attach to the
  // resumable SSE stream so the UI keeps ticking across refresh/navigation.
  useEffect(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }

    if (!selectedId) { setLoadedColony(null); return; }
    // Already being streamed by handleLaunch — don't double-attach.
    if (selectedId === activeColonyIdRef.current) return;

    let cancelled = false;
    setLoadingColony(true);
    setLoadedColony(null);

    api.getColony(selectedId)
      .then(async data => {
        if (cancelled) return;
        setLoadedColony(data);
        setLoadingColony(false);

        if (data.status === 'running') {
          setLiveLog([]);
          setLiveAgentColorMap({});
          clearStreaming();
          setLivePlan(data.plan || null);
          colorIndexRef.current = 0;
          setActiveColonyId(selectedId);

          const ac = new AbortController();
          streamAbortRef.current = ac;
          try {
            const res = await api.streamColony(selectedId, 0, ac.signal);
            if (cancelled || ac.signal.aborted) return;
            await consumeStream(res, selectedId, { fromLogEntries: true });
          } catch (e) {
            if (e.name !== 'AbortError' && !cancelled) {
              setLiveLog(prev => [...prev, { type: 'error', content: e.message }]);
            }
          }
        }
      })
      .catch(() => { if (!cancelled) setLoadingColony(false); });

    return () => {
      cancelled = true;
      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
        streamAbortRef.current = null;
      }
    };
  }, [selectedId, consumeStream, setActiveColonyId]);

  // ── Launch a run under the current colony ───────────────────────────────────
  const handleLaunch = async () => {
    const team = overview?.team;
    if (!team || (!goal.trim() && !selectedBoardCard) || !model) return;
    const sessionGoal = selectedBoardCard ? boardCardToGoal(selectedBoardCard, goal) : goal.trim();
    setLaunching(true);
    setLaunchError('');
    setLiveLog([]);
    setLiveAgentColorMap({});
    clearStreaming();
    setLivePlan(null);
    setLiveBlockers([]);
    setLivePrUrl(null);
    colorIndexRef.current = 0;

    try {
      const baseModel = (modelPlan && modelPlan.operator) || model;
      const triggerConfig = selectedWebhookId && triggerEvents.length > 0
        ? {
            webhook_id: selectedWebhookId,
            repo: projectBoard?.repo || undefined,
            event_types: triggerEvents,
            comment_token: commentToken || '@hive',
          }
        : undefined;
      const res = await api.launchColony(sessionGoal, baseModel, team.recipe_id, {
        teamId: team.id,
        boardCard: selectedBoardCard || undefined,
        cloudEnabled: team.cloud_enabled,
        githubWriteback: team.github_writeback,
        modelPlan: modelPlan || undefined,
        triggerConfig,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to start run');
      }

      setLaunching(false);
      setGoal('');

      let colonyId = null;
      const agentNameMap = {};

      const processEvent = (event) => {
        if (event.type === 'colony_id') {
          colonyId = event.colonyId;
          setActiveColonyId(colonyId);
          setLoadedColony(null);
          const stub = {
            id: colonyId, team_id: team.id, goal: sessionGoal, model: baseModel,
            recipe_id: team.recipe_id, status: 'running',
            agent_ids: [], created_at: Math.floor(Date.now() / 1000),
          };
          setColonies(prev => [stub, ...prev]);
          setOverview(prev => prev ? { ...prev, runs: [stub, ...(prev.runs || [])] } : prev);
          // Jump straight to the run page — this component stays mounted, so
          // the launch stream keeps flowing.
          navigate(`/colony/${team.id}/run/${colonyId}`);
          return;
        }

        if (event.type === 'log_entry' && event.entry) {
          // Most tool/agent/done entries are already streamed as structured
          // events on the launch path. These DB-only rows otherwise disappear
          // until replay, making live order look incomplete.
          const liveOnlyKinds = new Set(['preflight', 'recipe', 'bootstrap', 'writeback', 'sandbox_cleanup']);
          if (liveOnlyKinds.has(event.entry.kind)) {
            const converted = dbLogToEntries([event.entry], {});
            if (converted.length > 0) setLiveLog(prev => [...prev, ...converted]);
          }
          return;
        }

        if (event.type === 'token' && event.agent) {
          queueToken(event.agent, event.kind, event.delta);
          return;
        }

        if (event.type === 'plan_update' && event.plan) {
          setLivePlan(event.plan);
          return;
        }

        if (event.type === 'agent_ready' && event.agent?.name) {
          const agentName = event.agent.name;
          agentNameMap[event.agent.id] = agentName;
          setLiveAgentColorMap(prev => {
            if (prev[agentName]) return prev;
            const color = event.agent.avatar_color || AGENT_COLORS[colorIndexRef.current % AGENT_COLORS.length];
            colorIndexRef.current++;
            return { ...prev, [agentName]: color };
          });
        }

        const entries = sseToEntries(event, agentNameMap);
        if (entries.length > 0) setLiveLog(prev => [...prev, ...entries]);

        if (event.type === 'round_start' || event.type === 'orchestrator_message') {
          clearStreaming();
        }
        if (event.type === 'ws') {
          const m = event.msg || {};
          if ((m.type === 'sub_tool_call' || m.type === 'tool_call') && m.subAgent) {
            clearStreaming(m.subAgent);
          }
        }

        if (event.type === 'done' || event.type === 'error') {
          clearStreaming();
          const newStatus = event.type === 'done' ? (event.status || 'done') : 'error';
          if (colonyId) {
            setColonies(prev => prev.map(c => c.id === colonyId ? { ...c, status: newStatus } : c));
            setOverview(prev => prev ? {
              ...prev,
              runs: (prev.runs || []).map(r => r.id === colonyId ? { ...r, status: newStatus } : r),
            } : prev);
            api.getColony(colonyId).then(data => {
              setLoadedColony(prev => (prev?.id === colonyId ? data : prev) ?? data);
            }).catch(() => {});
          }
          setActiveColonyId(null);
        }
        if (event.type === 'blocker') {
          setLiveBlockers(prev => [...prev, event.blocker]);
        }
        if (event.type === 'writeback' && event.phase === 'pr_opened' && event.pr_url) {
          setLivePrUrl(event.pr_url);
        }
      };

      for await (const event of readSSEStream(res)) processEvent(event);
    } catch (e) {
      setLaunchError(e.message);
      setLiveLog(prev => [...prev, { type: 'error', content: e.message }]);
      setLaunching(false);
      setActiveColonyId(null);
    }
  };

  const handleStop = async () => {
    if (!activeColonyId) return;
    const id = activeColonyId;
    let result = null;
    try {
      result = await api.stopColony(id);
    } catch (e) {
      setLiveLog(prev => [...prev, { type: 'error', content: `Stop request failed: ${e.message}` }]);
      return;
    }
    if (result?.stopped) {
      setColonies(prev => prev.map(c => c.id === id ? { ...c, status: 'stopped' } : c));
      setOverview(prev => prev ? {
        ...prev,
        runs: (prev.runs || []).map(r => r.id === id ? { ...r, status: 'stopped' } : r),
      } : prev);
      setActiveColonyId(null);
    } else {
      setLiveLog(prev => [...prev, { type: 'error', content: `Stop did not take effect: ${result?.message || 'unknown reason'}` }]);
    }
  };

  const handleDeleteRun = async (id) => {
    await api.deleteColony(id).catch(() => {});
    setColonies(prev => prev.filter(c => c.id !== id));
    setOverview(prev => prev ? { ...prev, runs: (prev.runs || []).filter(r => r.id !== id) } : prev);
    if (activeColonyId === id) setActiveColonyId(null);
    if (selectedId === id) navigate(`/colony/${teamId}`);
  };

  const handleDeleteTeam = async (team) => {
    if (!window.confirm(`Delete colony "${team.name}" and all of its runs?`)) return;
    await api.deleteColonyTeam(team.id).catch(() => {});
    setTeams(prev => prev.filter(t => t.id !== team.id));
    if (teamId === team.id) navigate('/colony');
  };

  const handleExport = () => {
    const isLiveExport = selectedId === activeColonyId;
    const logData = isLiveExport ? liveLog : (loadedColony?.log || []);
    const colony = loadedColony || colonies.find(c => c.id === selectedId);
    const blob = new Blob([JSON.stringify({ goal: colony?.goal, model: colony?.model, recipe_id: colony?.recipe_id, status: colony?.status, log: logData }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `colony-run-${selectedId?.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Run view derived state ──────────────────────────────────────────────────
  const selectedColony = colonies.find(c => c.id === selectedId)
    || (overview?.runs || []).find(r => r.id === selectedId);
  const isLive = selectedId != null && selectedId === activeColonyId;

  const pastAgentColorMap = (() => {
    if (isLive || !loadedColony?.log) return {};
    const map = {};
    let idx = 0;
    for (const e of loadedColony.log) {
      if (e.kind === 'agent_ready' && e.agent?.name) {
        const name = e.agent.name;
        if (!map[name]) {
          map[name] = e.agent?.avatar_color || AGENT_COLORS[idx % AGENT_COLORS.length];
          idx++;
        }
      }
    }
    return map;
  })();

  const pastLog = loadedColony ? dbLogToEntries(loadedColony.log, pastAgentColorMap) : [];
  const displayColony = isLive
    ? { ...(loadedColony || selectedColony) }
    : (loadedColony ? { ...loadedColony } : selectedColony);
  const displayLog = isLive ? liveLog : pastLog;
  const displayColorMap = isLive ? liveAgentColorMap : pastAgentColorMap;

  const recipeNames = useMemo(
    () => Object.fromEntries(recipes.map(recipe => [recipe.id, recipe.name])),
    [recipes],
  );
  const team = overview?.team || teams.find(t => t.id === teamId) || null;

  // ── View: run page ──────────────────────────────────────────────────────────
  if (teamId && runId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 min-w-0 p-5 overflow-hidden flex flex-col">
          {loadingColony && !displayColony ? (
            <div className="flex items-center gap-2 text-gray-600 justify-center py-8"><Loader2 size={16} className="animate-spin" /><span className="text-sm">Loading run…</span></div>
          ) : displayColony ? (
            <ColonyLiveView
              colony={displayColony}
              log={displayLog}
              agentColorMap={displayColorMap}
              running={isLive}
              streamingByAgent={isLive ? streamingByAgent : {}}
              plan={isLive ? livePlan : loadedColony?.plan}
              onStop={handleStop}
              onExport={handleExport}
              onBack={() => navigate(`/colony/${teamId}`)}
              blockers={isLive ? liveBlockers : []}
              prUrl={isLive ? livePrUrl : null}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <XCircle size={32} className="text-gray-700" />
              <p className="text-gray-500 text-sm">Run not found</p>
              <Button variant="secondary" onClick={() => navigate(`/colony/${teamId}`)}><ArrowLeft size={13} /> Back to colony</Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── View: colony (team) page ────────────────────────────────────────────────
  if (teamId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800">
          <button onClick={() => navigate('/colony')} className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition flex-shrink-0" title="Back to all colonies">
            <ArrowLeft size={15} />
          </button>
          <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2 min-w-0">
            <Users size={18} className="text-blue-400/80 flex-shrink-0" />
            <span className="truncate">{team?.name || 'Colony'}</span>
          </h1>
          {team && (
            <span className="text-xs text-gray-400 border border-gray-800 bg-gray-900/60 rounded px-2 py-1 whitespace-nowrap flex-shrink-0" title="Team preset — the crew for each run; see the run page for the live roster">
              {recipeNames[team.recipe_id] || team.recipe_id}
              {(() => {
                const n = recipes.find(r => r.id === team.recipe_id)?.roles?.length;
                return n ? ` · ${n}-role crew` : '';
              })()}
            </span>
          )}
          {team && (
            <Button size="sm" variant="ghost" className="text-gray-500 hover:text-gray-300 flex-shrink-0" onClick={() => setTeamModal(team)}>
              <Pencil size={12} /> Edit
            </Button>
          )}
          {overview?.repo && (
            <span className="text-xs text-blue-300 bg-blue-950/30 border border-blue-900/40 rounded px-2 py-1 whitespace-nowrap ml-auto">
              {overview.repo.owner}/{overview.repo.repo}
            </span>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          {loadingOverview && !overview ? (
            <div className="flex items-center gap-2 text-gray-600 justify-center py-8"><Loader2 size={16} className="animate-spin" /><span className="text-sm">Loading colony…</span></div>
          ) : !team ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
              <XCircle size={32} className="text-gray-700" />
              <p className="text-gray-500 text-sm">Colony not found</p>
              <Button variant="secondary" onClick={() => navigate('/colony')}><ArrowLeft size={13} /> All colonies</Button>
            </div>
          ) : (
            <div className="max-w-5xl flex flex-col gap-4">
              {team.description && <p className="text-sm text-gray-400 leading-relaxed">{team.description}</p>}

              <PerformanceStrip performance={overview?.performance} />

              {/* ── Launch a run: pick a work item from the team's board ── */}
              <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 flex flex-col gap-3">
                <div className="flex items-center gap-1.5">
                  <Zap size={13} className="text-amber-400/80" />
                  <span className="text-xs font-semibold text-gray-300">Launch a run</span>
                  <span className="text-xs text-gray-600">— the operator staffs the crew and decides reasoning</span>
                </div>

                {projectBoard?.configured && (projectBoard.cards || []).length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-400">Work item</span>
                      {selectedBoardCard && (
                        <button type="button" onClick={() => setSelectedBoardCardId(null)} className="text-xs text-gray-500 hover:text-gray-300">unlink</button>
                      )}
                    </div>
                    <div className="relative">
                      <Search size={13} className="absolute left-3 top-2.5 text-gray-600" />
                      <input
                        value={boardSearch}
                        onChange={e => setBoardSearch(e.target.value)}
                        placeholder="Search issues and board tasks"
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
                      />
                    </div>
                    <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
                      {visibleBoardCards.map(card => {
                        const selected = selectedBoardCardId === card.id;
                        return (
                          <button
                            key={card.id}
                            type="button"
                            onClick={() => setSelectedBoardCardId(card.id)}
                            className={`w-full text-left px-3 py-2 transition-colors ${selected ? 'bg-blue-950/30' : 'bg-gray-900/40 hover:bg-gray-800/50'}`}
                          >
                            <div className="flex items-center gap-2">
                              <Link2 size={12} className={selected ? 'text-blue-300' : 'text-gray-600'} />
                              <span className="text-xs font-medium text-gray-200 truncate flex-1">{card.title}</span>
                              {card.number && <span className="text-xs text-gray-500">#{card.number}</span>}
                            </div>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-600">
                              <span>{card.status_label || card.status || 'backlog'}</span>
                              {card.url && <span className="truncate">{card.url}</span>}
                            </div>
                          </button>
                        );
                      })}
                      {visibleBoardCards.length === 0 && (
                        <div className="px-3 py-3 text-xs text-gray-600 text-center">No matching work items</div>
                      )}
                    </div>
                  </div>
                )}
                {projectBoard?.configured && (projectBoard.cards || []).length === 0 && (
                  <p className="text-xs text-gray-600">No task board found — the operator will have the PM draft tasks from the README/PRD.</p>
                )}
                {!projectBoard?.configured && (
                  <p className="text-xs text-amber-400/80">{projectBoard?.error || 'No repository configured — edit the colony to set one.'}</p>
                )}

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-gray-400">Direction</span>
                  <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={2}
                    placeholder={selectedBoardCard ? 'Optional notes for the selected work item…' : 'Describe what the team should work on…'}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-400">Operator / base model</span>
                    <button type="button" onClick={handleProposeModels} disabled={proposing} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 disabled:opacity-50">
                      {proposing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      {modelPlan ? 'Re-propose plan' : 'Let operator propose a per-role plan'}
                    </button>
                  </div>
                  <select value={model} onChange={e => setModel(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {Object.entries(groupedModels).map(([prov, list]) => {
                      const opts = (Array.isArray(list) ? list : []).filter(m => cloudEnabled || (m.provider || prov) === 'ollama');
                      if (opts.length === 0) return null;
                      return <optgroup key={prov} label={PROVIDER_LABEL[prov] || prov}>{opts.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}</optgroup>;
                    })}
                  </select>
                  {modelPlan && overview?.crew?.length > 0 && (
                    <div className="mt-1 rounded-lg border border-gray-800 overflow-hidden">
                      <div className="px-3 py-1.5 bg-gray-900/60 text-xs text-gray-500 border-b border-gray-800">Model plan — operator proposed, editable</div>
                      {[{ role_key: 'operator', display_name: 'Operator' }, ...overview.crew].map(member => (
                        <div key={member.role_key} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/60 last:border-0">
                          <span className="text-xs text-gray-400 w-32 flex-shrink-0 truncate">{member.display_name}</span>
                          <select value={modelPlan[member.role_key] || ''} onChange={e => setModelPlan(p => ({ ...p, [member.role_key]: e.target.value }))} className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
                            {models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                          </select>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <details className="group">
                  <summary className="text-xs font-medium text-gray-400 cursor-pointer hover:text-gray-300 select-none">Webhook trigger (optional)</summary>
                  <div className="flex flex-col gap-1.5 pt-2">
                    <select
                      value={selectedWebhookId}
                      onChange={e => setSelectedWebhookId(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">No webhook selected</option>
                      {webhooks.map(webhook => (
                        <option key={webhook.id} value={webhook.id}>{webhook.name}</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {[['issue', 'New issue'], ['task', 'New task'], ['comment', 'New comment']].map(([key, label]) => {
                        const on = triggerEvents.includes(key);
                        return (
                          <button key={key} type="button" onClick={() => setTriggerEvents(t => on ? t.filter(x => x !== key) : [...t, key])} className={`text-xs rounded-md px-2.5 py-1 border transition-colors ${on ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-gray-800 text-gray-500 hover:border-gray-700'}`}>
                            {on ? '✓ ' : ''}{label}
                          </button>
                        );
                      })}
                    </div>
                    {triggerEvents.includes('comment') && (
                      <input
                        value={commentToken}
                        onChange={e => setCommentToken(e.target.value)}
                        placeholder="@hive"
                        className="w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
                      />
                    )}
                  </div>
                </details>

                {launchError && <p className="text-xs text-red-400">{launchError}</p>}
                <Button onClick={handleLaunch} disabled={(!goal.trim() && !selectedBoardCard) || !model || launching || !!activeColonyId}>
                  {launching ? <><Loader2 size={13} className="animate-spin" /> Launching…</>
                    : activeColonyId ? <><Loader2 size={13} className="animate-spin" /> A run is in progress…</>
                    : <><Zap size={13} /> Launch run</>}
                </Button>
              </div>

              {/* ── Runs ── */}
              <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Clock size={13} className="text-blue-400/70" />
                  <span className="text-xs font-semibold text-gray-300">Runs</span>
                  <span className="text-xs text-gray-600">({overview?.runs?.length || 0})</span>
                </div>
                {(overview?.runs || []).length === 0 ? (
                  <p className="text-xs text-gray-600 py-2">No runs yet — pick a work item above and launch one.</p>
                ) : (
                  <div className="flex flex-col divide-y divide-gray-800/60">
                    {(overview?.runs || []).map(run => (
                      <div key={run.id} className="flex items-center gap-2.5 py-2 group">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[run.status] || 'bg-gray-700'}`} />
                        <button onClick={() => navigate(`/colony/${teamId}/run/${run.id}`)} className="flex-1 min-w-0 text-left">
                          <p className="text-xs font-medium text-gray-200 truncate group-hover:text-blue-300 transition-colors">{runLabel(run)}</p>
                          <p className="text-xs text-gray-600">
                            <span className={STATUS_TEXT[run.status] || ''}>{run.status}</span>
                            {' · '}{formatDate(run.created_at * 1000)}
                            {run.trigger?.event_type ? ` · triggered by ${run.trigger.event_type}` : ''}
                          </p>
                        </button>
                        <button onClick={() => handleDeleteRun(run.id)} className="p-1.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0" title="Delete this run">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <ArtifactsPanel artifacts={overview?.artifacts} onOpenArtifact={(runId, path) => setArtifactViewer({ runId, path })} />

              {/* Memory + Insights side by side — both are reference material,
                  below the action sections. */}
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
                <ColonyMemoryPanel
                  memory={overview?.team?.memory || ''}
                  onSave={async (memory) => {
                    const saved = await api.updateColonyTeam(team.id, { memory });
                    setOverview(prev => prev ? { ...prev, team: { ...prev.team, memory: saved.memory } } : prev);
                  }}
                />
                <InsightsPanel insights={overview?.insights} />
              </div>
            </div>
          )}
        </div>

        {teamModal && (
          <TeamConfigModal
            initial={teamModal === 'new' ? null : teamModal}
            recipes={recipes}
            onClose={() => setTeamModal(null)}
            onSaved={(saved) => {
              setTeamModal(null);
              setTeams(prev => {
                const exists = prev.some(t => t.id === saved.id);
                return exists ? prev.map(t => t.id === saved.id ? { ...t, ...saved } : t) : [...prev, saved];
              });
              reloadOverview();
            }}
          />
        )}

        {artifactViewer && (
          <ArtifactViewerModal
            key={`${artifactViewer.runId}:${artifactViewer.path}`}
            runId={artifactViewer.runId}
            path={artifactViewer.path}
            onClose={() => setArtifactViewer(null)}
          />
        )}
      </div>
    );
  }

  // ── View: main colony tab (colony cards) ────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800">
        <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2 flex-shrink-0">
          <Users size={18} className="text-gray-400" /> Colony
        </h1>
        <span className="text-xs text-gray-600">Persistent teams — open one to see its crew, runs, and artifacts</span>
        <Button className="ml-auto flex-shrink-0" onClick={() => setTeamModal('new')}>
          <Plus size={14} /> New colony
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Users size={40} className="text-gray-700" />
            <p className="text-gray-500 text-sm">No colonies yet</p>
            <p className="text-gray-600 text-xs max-w-sm">A colony is a named team with its own repo, crew, and run history — create one to get started.</p>
            <Button onClick={() => setTeamModal('new')}><Plus size={13} /> Create your first colony</Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-w-5xl">
            {teams.map(t => (
              <ColonyCard
                key={t.id}
                team={t}
                recipeNames={recipeNames}
                onOpen={() => navigate(`/colony/${t.id}`)}
                onDelete={() => handleDeleteTeam(t)}
              />
            ))}
          </div>
        )}
      </div>

      {teamModal && (
        <TeamConfigModal
          initial={teamModal === 'new' ? null : teamModal}
          recipes={recipes}
          onClose={() => setTeamModal(null)}
          onSaved={(saved) => {
            setTeamModal(null);
            api.getColonyTeams().then(setTeams).catch(() => {});
            navigate(`/colony/${saved.id}`);
          }}
        />
      )}
    </div>
  );
}
