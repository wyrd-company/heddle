// ---
// relationships:
//   implements: heddle
// ---

export {
  AgentNameAllocator,
  type AgentNameAllocationStore,
} from "./allocator.js";
export {
  AgentNameCatalogError,
  GitAgentNameThemeCatalog,
  agentNameListNames,
  agentNameThemeKindForList,
  namesForThemeList,
  validateAgentNameThemeRepository,
  type AgentNameListName,
  type AgentNameTheme,
  type AgentNameThemeCatalogSnapshot,
  type AgentNameThemeKind,
  type SoloistAgentNameTheme,
  type TeamAgentNameTheme,
} from "./theme-catalog.js";
