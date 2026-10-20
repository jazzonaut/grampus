// Shared fixed assignments for model profile and export scenarios.
export const profile = {
  id: 'balanced',
  name: 'Balanced',
  planning: { provider: 'codex', model: 'planner', effort: 'high' },
  implementation: { provider: 'codex', model: 'writer', effort: 'low' },
  repair: { provider: 'codex', model: 'repairer', effort: 'high' },
  review: { provider: 'claude', model: 'reviewer', effort: 'high' },
  qualityPasses: { documentation: { provider: 'codex', model: 'documenter', effort: 'low' } },
};
