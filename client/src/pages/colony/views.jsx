import { Trash2, Clock, XCircle, Loader2, Users, ArrowLeft, Plus, Pencil, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toastStore';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../lib/utils';
import {
  ArtifactsPanel, ArtifactViewerModal, ColonyCard, ColonyLiveView, ColonyMemoryPanel,
  CrewPanel, InsightsPanel, PerformanceStrip, RecipeGhostCard, StartRunModal,
  TeamConfigModal, UnroutedTray, WorkQueuePanel,
} from './components';
import { STATUS_DOT, STATUS_TEXT, runLabel } from './helpers';
import { useColonyPage } from './useColonyPage';

// ── Run page (/colony/:teamId/run/:runId) ─────────────────────────────────────
function RunView(page) {
  const {
    teamId, navigate, loadingColony, loadedColony, displayColony, displayLog, displayColorMap,
    isLive, streamingByAgent, livePlan, displayBlockers, displayPrUrl,
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
            blockers={displayBlockers}
            prUrl={displayPrUrl}
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

// ── Colony team room (/colony/:teamId) ────────────────────────────────────────
// Identity first (crew + charter), the work queue alongside, history below.
// There is no launch form: work is queued, and a queued item's Start step
// collects the direction + model plan.
function TeamView(page) {
  const {
    teamId, navigate, team, setTeams, recipes, recipeNames,
    teamModal, setTeamModal, overview, loadingOverview, reloadOverview,
    artifactViewer, setArtifactViewer,
    queue, reloadQueue,
    giveWorkOpen, setGiveWorkOpen, addingWork, handleAddWork,
    handleAcceptItem, handleDismissItem, handleDeleteItem,
    startItem, setStartItem, openStartItem, startDirection, setStartDirection, handleStartItem,
    goal, setGoal, model, setModel, models, groupedModels, cloudEnabled,
    modelPlan, setModelPlan, proposing, handleProposeModels,
    projectBoard, selectedBoardCard, selectedBoardCardId, setSelectedBoardCardId,
    boardSearch, setBoardSearch, visibleBoardCards,
    launching, launchError, launchAdvancedOpen, setLaunchAdvancedOpen,
    activeColonyId, handleDeleteRun, saveTeamMemory,
  } = page;

  const queueBoardCard = async (card) => {
    try {
      await api.addTeamQueueItem(teamId, { board_card: card });
      reloadQueue();
    } catch (e) {
      toast.error(`Failed to queue work item: ${e.message}`);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800">
        <button onClick={() => navigate('/colony')} className="p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition flex-shrink-0" title="Back to the roster">
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
            {/* ── Charter ── */}
            {team.description && <p className="text-sm text-gray-400 leading-relaxed">{team.description}</p>}

            {/* ── Identity: the crew leads the page ── */}
            <CrewPanel crew={overview?.crew} recipeName={recipeNames[team.recipe_id] || team.recipe_id} />

            {/* ── Work: the colony's queue (proposed → queued → claimed) ── */}
            <WorkQueuePanel
              queue={queue}
              activeColonyId={activeColonyId}
              giveWorkOpen={giveWorkOpen}
              setGiveWorkOpen={setGiveWorkOpen}
              addingWork={addingWork}
              onAddWork={handleAddWork}
              goal={goal}
              setGoal={setGoal}
              projectBoard={projectBoard}
              selectedBoardCard={selectedBoardCard}
              selectedBoardCardId={selectedBoardCardId}
              setSelectedBoardCardId={setSelectedBoardCardId}
              boardSearch={boardSearch}
              setBoardSearch={setBoardSearch}
              visibleBoardCards={visibleBoardCards}
              onAccept={handleAcceptItem}
              onDismiss={handleDismissItem}
              onDelete={handleDeleteItem}
              onStart={openStartItem}
              onOpenRun={(runId) => navigate(`/colony/${teamId}/run/${runId}`)}
              onQueueCard={queueBoardCard}
            />

            {/* ── History ── */}
            <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock size={13} className="text-blue-400/70" />
                <span className="text-xs font-semibold text-gray-300">Runs</span>
                <span className="text-xs text-gray-600">({overview?.runs?.length || 0})</span>
              </div>
              {(overview?.runs || []).length === 0 ? (
                <p className="text-xs text-gray-600 py-2">No runs yet — give the team work above and hit Start.</p>
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

            <PerformanceStrip performance={overview?.performance} />

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

      {startItem && (
        <StartRunModal
          item={startItem}
          direction={startDirection}
          setDirection={setStartDirection}
          model={model}
          setModel={setModel}
          models={models}
          groupedModels={groupedModels}
          cloudEnabled={cloudEnabled}
          modelPlan={modelPlan}
          setModelPlan={setModelPlan}
          crew={overview?.crew || []}
          proposing={proposing}
          onProposeModels={handleProposeModels}
          advancedOpen={launchAdvancedOpen}
          setAdvancedOpen={setLaunchAdvancedOpen}
          launching={launching}
          error={launchError}
          activeColonyId={activeColonyId}
          onStart={handleStartItem}
          onClose={() => setStartItem(null)}
        />
      )}

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

// ── Roster (/colony) ──────────────────────────────────────────────────────────
// The front door: every colony with live status, the Unrouted tray, and the
// recipe catalog as a hiring hall of foundable ghost cards.
function ColonyListView(page) {
  const {
    navigate, teams, setTeams, recipes, recipeNames, teamModal, setTeamModal,
    handleDeleteTeam, unrouted, handleRouteUnrouted, handleDismissUnrouted,
  } = page;

  const foundableRecipes = recipes
    .slice()
    .sort((a, b) => String(a.category || 'zzz').localeCompare(String(b.category || 'zzz')) || a.name.localeCompare(b.name));

  const hiringHall = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <Sparkles size={13} className="text-gray-500" />
        <span className="text-xs font-semibold text-gray-400">Hiring hall</span>
        <span className="text-xs text-gray-600">— found a new colony from a recipe</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-w-5xl">
        {foundableRecipes.map(recipe => (
          <RecipeGhostCard key={recipe.id} recipe={recipe} onFound={() => setTeamModal({ presetRecipe: recipe.id })} />
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-800">
        <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2 flex-shrink-0">
          <Users size={18} className="text-gray-400" /> Colonies
        </h1>
        <span className="text-xs text-gray-600">Your teams, live — work flows to them; open one to manage its queue</span>
        <Button className="ml-auto flex-shrink-0" onClick={() => setTeamModal('new')}>
          <Plus size={14} /> New colony
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {teams.length === 0 ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col items-center gap-2 text-center py-6">
              <Users size={40} className="text-gray-700" />
              <p className="text-gray-400 text-sm font-medium">Found your first colony</p>
              <p className="text-gray-600 text-xs max-w-md">A colony is a persistent team with its own crew, repo, memory, and work queue. Pick a recipe below — founding takes a name and a repo.</p>
            </div>
            {hiringHall}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <UnroutedTray
              items={unrouted}
              teams={teams}
              onRoute={handleRouteUnrouted}
              onDismiss={handleDismissUnrouted}
            />
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
            {hiringHall}
          </div>
        )}
      </div>

      {teamModal && (
        <TeamConfigModal
          initial={teamModal === 'new' || teamModal?.presetRecipe ? null : teamModal}
          presetRecipeId={teamModal?.presetRecipe || null}
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
