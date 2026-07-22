// Canonical expanded catalog assembly. Recipe definitions are grouped by
// product domain; runtime consumers use recipeRegistry, which combines these
// with founding presets and validates the complete registry before use.
const { ROLE_PERSONA } = require('./recipePersonas');
const { ENGINEERING_RECIPES } = require('./recipeDefinitionsEngineering');
const { GROWTH_RECIPES } = require('./recipeDefinitionsGrowth');
const { OPERATIONS_RECIPES } = require('./recipeDefinitionsOperations');

const RECIPE_DEFS = [
  ...ENGINEERING_RECIPES,
  ...GROWTH_RECIPES,
  ...OPERATIONS_RECIPES,
];

for (const recipe of RECIPE_DEFS) {
  for (const role of recipe.roles) {
    const persona = ROLE_PERSONA[`${recipe.id}/${role.key}`] || {};
    role.personality = persona.personality || '';
    role.skills = Array.isArray(persona.skills) && persona.skills.length ? persona.skills : [role.role];
  }
}

const CATALOG_RECIPES = Object.fromEntries(RECIPE_DEFS.map(recipe => [recipe.id, recipe]));

module.exports = { CATALOG_RECIPES };
