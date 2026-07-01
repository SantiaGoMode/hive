import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { AGENT_COLORS, sseToEntries, dbLogToEntries } from '../../lib/colonyUtils';
import { readSSEStream } from '../../lib/streamParser';
import { BOARD_LANES, boardCardToGoal, flattenModels, preferredFlatModel } from './helpers';

// Pure state/handlers hook for the colony pages. The views live in views.jsx;
// this returns everything they need and no JSX.
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
  const [launchAdvancedOpen, setLaunchAdvancedOpen] = useState(false);

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
  // Ref mirror of the selected run id so the shared event processor can read
  // the current selection without re-creating on navigation.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

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

  // ── Shared SSE event processor ──────────────────────────────────────────────
  // One processor for both the launch stream and the resume stream — the two
  // used to be near-duplicate copies that drifted apart.
  //
  // mode 'live'  (launch): structured events become log entries via
  //   sseToEntries; log_entry rows are converted only for DB-only kinds that
  //   have no structured twin (otherwise they'd duplicate).
  // mode 'replay' (resume): the server replays the DB log as log_entry rows,
  //   so every row is converted and structured events are NOT double-converted.
  const createEventProcessor = useCallback(({ mode, initialColonyId = null, onColonyStart = null }) => {
    let colonyId = initialColonyId;
    const agentNameMap = {};
    const liveOnlyKinds = new Set(['preflight', 'recipe', 'bootstrap', 'writeback', 'outcome', 'sandbox_cleanup']);

    return (event) => {
      if (event.type === 'colony_id') {
        colonyId = event.colonyId;
        setActiveColonyId(colonyId);
        onColonyStart?.(colonyId);
        return;
      }

      if (event.type === 'log_entry') {
        if (event.entry && (mode === 'replay' || liveOnlyKinds.has(event.entry.kind))) {
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

      const entries = mode === 'replay' ? [] : sseToEntries(event, agentNameMap);
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
            setLoadedColony(prev => (
              prev?.id === colonyId || selectedIdRef.current === colonyId ? data : (prev ?? data)
            ));
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
  }, [setActiveColonyId, queueToken, clearStreaming]);

  const resetLiveState = useCallback(({ plan = null } = {}) => {
    setLiveLog([]);
    setLiveAgentColorMap({});
    clearStreaming();
    setLivePlan(plan);
    setLiveBlockers([]);
    setLivePrUrl(null);
    colorIndexRef.current = 0;
  }, [clearStreaming]);

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
          resetLiveState({ plan: data.plan || null });
          setActiveColonyId(selectedId);

          const ac = new AbortController();
          streamAbortRef.current = ac;
          try {
            const res = await api.streamColony(selectedId, 0, ac.signal);
            if (cancelled || ac.signal.aborted) return;
            const processEvent = createEventProcessor({ mode: 'replay', initialColonyId: selectedId });
            for await (const event of readSSEStream(res)) processEvent(event);
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
  }, [selectedId, createEventProcessor, resetLiveState, setActiveColonyId]);

  // ── Launch a run under the current colony ───────────────────────────────────
  const handleLaunch = async () => {
    const team = overview?.team;
    if (!team || (!goal.trim() && !selectedBoardCard) || !model) return;
    const sessionGoal = selectedBoardCard ? boardCardToGoal(selectedBoardCard, goal) : goal.trim();
    setLaunching(true);
    setLaunchError('');
    resetLiveState();

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

      const processEvent = createEventProcessor({
        mode: 'live',
        onColonyStart: (colonyId) => {
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
        },
      });

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
    try {
      await api.deleteColony(id);
    } catch (e) {
      // Don't remove the row on failure — a delete that silently "succeeds"
      // in the UI but not the DB reappears on refresh.
      toast.error(`Failed to delete run: ${e.message}`);
      return;
    }
    setColonies(prev => prev.filter(c => c.id !== id));
    setOverview(prev => prev ? { ...prev, runs: (prev.runs || []).filter(r => r.id !== id) } : prev);
    if (activeColonyId === id) setActiveColonyId(null);
    if (selectedId === id) navigate(`/colony/${teamId}`);
  };

  const handleDeleteTeam = async (team) => {
    if (!window.confirm(`Delete colony "${team.name}" and all of its runs?`)) return;
    try {
      await api.deleteColonyTeam(team.id);
    } catch (e) {
      toast.error(`Failed to delete colony: ${e.message}`);
      return;
    }
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

  // Memoized — dbLogToEntries over the full log is O(log size) and must not
  // re-run on every render (renders happen every ~80ms during token flushes).
  const pastAgentColorMap = useMemo(() => {
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
  }, [isLive, loadedColony]);

  const pastLog = useMemo(
    () => (loadedColony ? dbLogToEntries(loadedColony.log, pastAgentColorMap) : []),
    [loadedColony, pastAgentColorMap],
  );

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

  const saveTeamMemory = useCallback(async (memory) => {
    if (!team) return;
    const saved = await api.updateColonyTeam(team.id, { memory });
    setOverview(prev => prev ? { ...prev, team: { ...prev.team, memory: saved.memory } } : prev);
  }, [team]);

  return {
    // routing
    teamId, runId, navigate,
    // teams / recipes
    teams, setTeams, recipes, recipeNames, team,
    teamModal, setTeamModal,
    overview, setOverview, loadingOverview, reloadOverview,
    artifactViewer, setArtifactViewer,
    // launch form
    goal, setGoal, model, setModel, models, groupedModels, cloudEnabled,
    modelPlan, setModelPlan, proposing, handleProposeModels,
    triggerEvents, setTriggerEvents, webhooks, selectedWebhookId, setSelectedWebhookId,
    commentToken, setCommentToken,
    projectBoard, selectedBoardCard, selectedBoardCardId, setSelectedBoardCardId,
    boardSearch, setBoardSearch, visibleBoardCards,
    launching, launchError, launchAdvancedOpen, setLaunchAdvancedOpen,
    // run display
    loadingColony, loadedColony, displayColony, displayLog, displayColorMap,
    isLive, streamingByAgent, livePlan, liveBlockers, livePrUrl, activeColonyId,
    // actions
    handleLaunch, handleStop, handleExport, handleDeleteRun, handleDeleteTeam,
    saveTeamMemory,
  };
}
