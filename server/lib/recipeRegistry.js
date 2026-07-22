const { CATALOG_RECIPES } = require('./recipeCatalog');
const { FOUNDING_RECIPES } = require('./foundingRecipes');

const CUSTOM_AUTO_RECIPE_ID = 'custom_auto';
const DEFAULT_RECIPE_ID = 'development_team';
const EXECUTION_MODES = new Set(['read_only', 'artifact_only', 'repository_write']);

const CUSTOM_AUTO_RECIPE = {
  id: CUSTOM_AUTO_RECIPE_ID,
  name: 'Custom Auto',
  summary: 'Open-ended adaptive mission',
  placeholder: 'Describe what you want the colony to build or accomplish...\ne.g. Build a REST API that tracks cryptocurrency prices and stores them in SQLite',
  execution_policy: { mode: 'repository_write', github_review: false, github_publish: true },
  roles: [],
};

function validateRecipeDefinitions(recipes) {
  if (!recipes || typeof recipes !== 'object' || Array.isArray(recipes)) {
    throw new Error('Recipe registry must be an object keyed by recipe id');
  }

  for (const [registryId, recipe] of Object.entries(recipes)) {
    if (!recipe || recipe.id !== registryId) {
      throw new Error(`Recipe registry key mismatch: ${registryId}`);
    }
    for (const field of ['name', 'summary', 'placeholder']) {
      if (typeof recipe[field] !== 'string' || !recipe[field].trim()) {
        throw new Error(`Recipe ${registryId} is missing ${field}`);
      }
    }
    if (!Array.isArray(recipe.roles)) throw new Error(`Recipe ${registryId} roles must be an array`);
    if (registryId !== CUSTOM_AUTO_RECIPE_ID && recipe.roles.length === 0) {
      throw new Error(`Recipe ${registryId} must define at least one role`);
    }
    if (!EXECUTION_MODES.has(recipe.execution_policy?.mode)) {
      throw new Error(`Recipe ${registryId} has an invalid execution policy`);
    }

    const roleKeys = new Set();
    for (const role of recipe.roles) {
      if (!role?.key || roleKeys.has(role.key)) {
        throw new Error(`Recipe ${registryId} has a missing or duplicate role key: ${role?.key || '(missing)'}`);
      }
      roleKeys.add(role.key);
      for (const field of ['name', 'agent_name', 'role', 'prompt']) {
        if (typeof role[field] !== 'string' || !role[field].trim()) {
          throw new Error(`Recipe ${registryId}/${role.key} is missing ${field}`);
        }
      }
      if (!Array.isArray(role.tools)) throw new Error(`Recipe ${registryId}/${role.key} tools must be an array`);
    }
  }
  return recipes;
}

const RECIPES = validateRecipeDefinitions({
  [CUSTOM_AUTO_RECIPE_ID]: CUSTOM_AUTO_RECIPE,
  ...FOUNDING_RECIPES,
  ...CATALOG_RECIPES,
});

module.exports = {
  CUSTOM_AUTO_RECIPE_ID,
  DEFAULT_RECIPE_ID,
  RECIPES,
  validateRecipeDefinitions,
};
