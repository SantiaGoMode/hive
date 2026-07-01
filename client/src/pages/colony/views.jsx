import { Zap, Trash2, Clock, XCircle, Loader2, Users, RefreshCw, ArrowLeft, Plus, Pencil, Search, Link2, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../lib/utils';
import {
  ArtifactsPanel, ArtifactViewerModal, ColonyCard, ColonyLiveView, ColonyMemoryPanel,
  InsightsPanel, PerformanceStrip, TeamConfigModal,
} from './components';
import { PROVIDER_LABEL, STATUS_DOT, STATUS_TEXT, runLabel } from './helpers';
import { useColonyPage } from './useColonyPage';

// ── Run page (/colony/:teamId/run/:runId) ─────────────────────────────────────
function RunView(page) {
  const {
    teamId, navigate, loadingColony, loadedColony, displayColony, displayLog, displayColorMap,
    isLive, streamingByAgent, livePlan, liveBlockers, livePrUrl,
    handleStop, handleExport,
  } = page;

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

// ── Colony (team) page (/colony/:teamId) ──────────────────────────────────────
function TeamView(page) {
  const {
    teamId, navigate, team, setTeams, recipes, recipeNames,
    teamModal, setTeamModal, overview, loadingOverview, reloadOverview,
    artifactViewer, setArtifactViewer,
    goal, setGoal, model, setModel, models, groupedModels, cloudEnabled,
    modelPlan, setModelPlan, proposing, handleProposeModels,
    triggerEvents, setTriggerEvents, webhooks, selectedWebhookId, setSelectedWebhookId,
    commentToken, setCommentToken,
    projectBoard, selectedBoardCard, selectedBoardCardId, setSelectedBoardCardId,
    boardSearch, setBoardSearch, visibleBoardCards,
    launching, launchError, launchAdvancedOpen, setLaunchAdvancedOpen,
    activeColonyId, handleLaunch, handleDeleteRun, saveTeamMemory,
  } = page;

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
                <span className="text-xs font-medium text-gray-400">Operator / base model</span>
                <select value={model} onChange={e => setModel(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  {Object.entries(groupedModels).map(([prov, list]) => {
                    const opts = (Array.isArray(list) ? list : []).filter(m => cloudEnabled || (m.provider || prov) === 'ollama');
                    if (opts.length === 0) return null;
                    return <optgroup key={prov} label={PROVIDER_LABEL[prov] || prov}>{opts.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}</optgroup>;
                  })}
                </select>
              </div>

              <div className="rounded-lg border border-gray-800 bg-gray-950/30">
                <button
                  type="button"
                  aria-expanded={launchAdvancedOpen}
                  aria-controls="colony-launch-advanced"
                  onClick={() => setLaunchAdvancedOpen(v => !v)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-800/40 transition-colors"
                >
                  <div>
                    <p className="text-xs font-medium text-gray-300">Advanced launch settings</p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      {modelPlan ? 'Per-role model plan · ' : ''}{selectedWebhookId ? 'webhook trigger selected' : 'per-role model plan and webhook trigger'}
                    </p>
                  </div>
                  <ChevronRight size={13} className={`text-gray-500 transition-transform ${launchAdvancedOpen ? 'rotate-90' : ''}`} />
                </button>
                {launchAdvancedOpen && (
                  <div id="colony-launch-advanced" className="border-t border-gray-800 px-3 py-3">
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-gray-400">Per-role model plan</span>
                          <button type="button" onClick={handleProposeModels} disabled={proposing} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 disabled:opacity-50">
                            {proposing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                            {modelPlan ? 'Re-propose plan' : 'Let operator propose'}
                          </button>
                        </div>
                        {modelPlan && overview?.crew?.length > 0 && (
                          <div className="rounded-lg border border-gray-800 overflow-hidden">
                            <div className="px-3 py-1.5 bg-gray-900/60 text-xs text-gray-500 border-b border-gray-800">Operator proposed, editable</div>
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

                      <div className="flex flex-col gap-1.5 pt-3 border-t border-gray-800">
                        <span className="text-xs font-medium text-gray-400">Webhook trigger</span>
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
                    </div>
                  </div>
                )}
              </div>

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
                      <button onClick={() => handleDeleteRun(run.id)} className="p-1.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition flex-shrink-0" title="Delete this run">
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
                onSave={saveTeamMemory}
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

// ── Main colony tab (/colony) ─────────────────────────────────────────────────
function ColonyListView(page) {
  const { navigate, teams, setTeams, recipes, recipeNames, teamModal, setTeamModal, handleDeleteTeam } = page;

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

export function ColonyPageView() {
  const page = useColonyPage();
  if (page.teamId && page.runId) return <RunView {...page} />;
  if (page.teamId) return <TeamView {...page} />;
  return <ColonyListView {...page} />;
}
