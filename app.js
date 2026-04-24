// Initialize mermaid - wait for it to be available
function initMermaid() {
  if (typeof mermaid === 'undefined') {
    console.warn('Mermaid not loaded yet, retrying...');
    setTimeout(initMermaid, 100);
    return;
  }
  
  try {
    mermaid.initialize({ 
      startOnLoad: false, 
      theme: 'dark',
      themeVariables: {
        primaryColor: '#1a2540',
        primaryBorderColor: '#38bdf8',
        lineColor: '#38bdf8',
        textColor: '#e0e7ff',
        fontSize: '12px'
      },
      flowchart: {
        htmlLabels: true,
        useMaxWidth: true
      },
      logLevel: 'error'
    });
  } catch (error) {
    console.error('Failed to initialize Mermaid:', error);
  }
}

// Initialize immediately
initMermaid();

// Reltio Configuration Parser
class ReltioConfigParser {
  constructor(config) {
    this.rawConfig = config;
    this.parse();
  }

  parse() {
    this.sources = this.rawConfig.sources || [];
    this.entities = this.parseEntityTypes();
    this.attributes = this.extractAllAttributes();
    this.relationships = this.rawConfig.relationTypes || [];
    this.graphTypes = this.rawConfig.graphTypes || [];
    this.survivorshipStrategies = this.rawConfig.survivorshipStrategies || [];
  }

  parseEntityTypes() {
    return (this.rawConfig.entityTypes || []).map(entity => ({
      uri: entity.uri,
      label: entity.label,
      description: entity.description || '',
      typeColor: entity.typeColor || '#000000',
      typeIcon: entity.typeIcon,
      attributeCount: (entity.attributes || []).length,
      attributes: entity.attributes || [],
      relationshipCount: this.countEntityRelationships(entity.uri),
      survivorshipGroupCount: (entity.survivorshipGroups || []).length,
      matchGroupCount: (entity.matchGroups || []).length,
      isAbstract: entity.abstract || false,
      extendsTypeURI: entity.extendsTypeURI,
      cleanseConfig: entity.cleanseConfig
    }));
  }

  extractAllAttributes() {
    const allAttrs = [];
    (this.rawConfig.entityTypes || []).forEach(entity => {
      this.extractAttributesRecursively(entity.attributes || [], entity.label, allAttrs);
    });
    return allAttrs;
  }

  extractAttributesRecursively(attributes, entityLabel, collection, depth = 0) {
    (attributes || []).forEach(attr => {
      if (attr.uri && attr.label) {
        collection.push({
          uri: attr.uri,
          label: attr.label,
          type: attr.type || 'unknown',
          entity: entityLabel,
          depth: depth,
          isNested: depth > 0,
          multiValue: attr.multiValue || false,
          description: attr.description || ''
        });
        
        // Recursively handle nested attributes
        if (attr.attributes && Array.isArray(attr.attributes)) {
          this.extractAttributesRecursively(attr.attributes, entityLabel, collection, depth + 1);
        }
      }
    });
  }

  countEntityRelationships(entityUri) {
    let count = 0;
    (this.rawConfig.relationTypes || []).forEach(rel => {
      if (rel.startObject?.objectTypeURI === entityUri || rel.endObject?.objectTypeURI === entityUri) {
        count++;
      }
    });
    return count;
  }

  getSourcesToDisplay() {
    return this.sources.slice(0, 12);
  }

  getEntityRelationships(entityUri) {
    return this.relationships.filter(rel => 
      rel.startObject?.objectTypeURI === entityUri || rel.endObject?.objectTypeURI === entityUri
    );
  }
}

let configParser = null;
let _archGroupFilter  = new Set(); // multi-select: selected entity group labels
let _archSourceFilter = new Set(); // multi-select: selected source system labels
let recipeConnections = null;  // extracted from imported recipes
let recipeActiveMap   = {};    // "group / project / recipeName" → boolean (true = active)
// Per-recipe text hints gathered from ALL steps (including Reltio steps).
// Keyed by "proj / recipeName".  Values are arrays of strings that may contain
// entity label text: step titles, step names, Reltio entityType paths, etc.
let _recipeEntityHints = {};   // recipeKey → string[]
// Reltio action steps are the authoritative source for what gets written into Reltio.
// Keyed by "proj / recipeName".  Each entry is one Reltio upsert/create step:
//   { entityTypePath: string, pillCount: number }
// pillCount = unique data pills in that step = source fields being mapped to that entity.
let _recipeReltioMappings = {}; // recipeKey → [{ entityTypePath, attrShortNames: string[], pillCount }]
let _dataloaderMappings = null;  // entityTypeUri → string[] (top-level attr short names loaded via Dataloader)
let _dataloaderFieldMaps = null; // entityTypeUri → { attrShortName: sourceFieldName }
let _rdmData = null; // lookupTypeName → { sources: string[], values: [{code, reltioValue, sourceMappings:{src:val}}] }
let _archShowInactive = false; // whether inactive sources are visible on arch map
let _archShowInactiveGroups = false; // whether entity groups with no recipe data are visible
let _archDiagramMode = 'flow'; // 'flow' = source→entity flow, 'model' = entity→entity relationships
let _entityDetailShowUnmapped = {}; // entityIndex → boolean (true = show unmapped attrs)
let _entityDetailLastIdx = null;    // index of last entity shown in detail panel

// ── Recipe Connection Extraction ─────────────────────────────────────────────
// Walk all recipe steps recursively and derive external system connections.
const KNOWN_PROVIDERS = {
  salesforce: 'Salesforce', sfdc: 'Salesforce',
  servicenow: 'ServiceNow', sn: 'ServiceNow',
  snowflake: 'Snowflake',
  sap: 'SAP',
  workday: 'Workday',
  dynamics: 'Microsoft Dynamics', msdynamics: 'Microsoft Dynamics',
  hubspot: 'HubSpot',
  zendesk: 'Zendesk',
  marketo: 'Marketo',
  eloqua: 'Oracle Eloqua',
  dnb: 'D&B', dun_bradstreet: 'D&B',
  zoominfo: 'ZoomInfo',
  linkedin: 'LinkedIn',
  s3: 'Amazon S3', amazon_s3: 'Amazon S3',
  google: 'Google Workspace',
  azure: 'Azure',
  oracle: 'Oracle',
  netsuite: 'NetSuite',
};

const IGNORED_PROVIDERS = new Set(['reltio', 'workato', 'clock', 'variables', 'flow_control', 'logger', '']);

function normalizeProvider(raw) {
  if (!raw) return null;
  const p = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (IGNORED_PROVIDERS.has(p)) return null;
  for (const [key, label] of Object.entries(KNOWN_PROVIDERS)) {
    if (p.startsWith(key) || p.includes(key)) return label;
  }
  return raw.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function classifyStepDirection(step) {
  const n = (step.name || '').toLowerCase();
  const kw = (step.keyword || '').toLowerCase();
  if (kw === 'trigger' || n.includes('trigger') || n.startsWith('new_') ||
      n.startsWith('updated_') || n.includes('scheduler') || n.includes('timer') ||
      n.includes('webhook') || n.includes('event')) return 'inbound';
  if (n.includes('create') || n.includes('update') || n.includes('upsert') ||
      n.includes('insert') || n.includes('add') || n.includes('write') ||
      n.includes('send') || n.includes('post') || n.includes('put') ||
      n.includes('delete') || n.includes('patch')) return 'outbound';
  if (n.includes('search') || n.includes('find') || n.includes('get') ||
      n.includes('query') || n.includes('read') || n.includes('list') ||
      n.includes('fetch') || n.includes('lookup')) return 'inbound';
  return 'action';
}

function extractRecipeConnections(recipesData) {
  if (!recipesData || typeof recipesData !== 'object') return [];
  const sysByKey = {};

  // Support both old flat format { project: [recipes] } and new 3-level format { group: { project: [recipes] } }
  function _isThreeLevel(data) {
    const first = Object.values(data || {})[0];
    return first && !Array.isArray(first) && typeof first === 'object';
  }
  const flatProjects = {};
  if (_isThreeLevel(recipesData)) {
    Object.entries(recipesData).forEach(([group, projects]) => {
      Object.entries(projects || {}).forEach(([proj, recipes]) => {
        flatProjects[`${group} / ${proj}`] = recipes;
      });
    });
  } else {
    Object.assign(flatProjects, recipesData);
  }

  function walkSteps(steps, recipeName, projectName) {
    (steps || []).forEach(step => {
      // ── Harvest entity hints from EVERY step, regardless of provider ──────
      // This is the only way to capture Reltio-side entity types, which are
      // always literal config strings (never data pills) like:
      //   input.entityType = "configuration/entityTypes/FinancialAccount"
      // User-written step titles also name the entity directly.
      const recipeKey = `${projectName} / ${recipeName}`;
      if (!_recipeEntityHints[recipeKey]) _recipeEntityHints[recipeKey] = [];
      if (step.title) _recipeEntityHints[recipeKey].push(step.title);
      if (step.name)  _recipeEntityHints[recipeKey].push(step.name.replace(/_/g, ' '));
      // entityType / object fields are literal config values even in pill-heavy recipes
      const etRaw = (step.input?.entityType || step.input?.object_type ||
                     step.input?.object     || step.input?.entity_type || '');
      if (etRaw) {
        // Push both the full URI and just the last path segment
        _recipeEntityHints[recipeKey].push(String(etRaw));
        _recipeEntityHints[recipeKey].push(String(etRaw).split('/').pop().replace(/([A-Z])/g, ' $1').trim());
      }

      // ── Salesforce trigger: extract field list for accurate field counts ──
      // Batch sync recipes have a Salesforce trigger with dynamicPickListSelection.field_list
      // containing every field being pulled. The count is the accurate "fields being synced".
      // The sobject name (Account/Contact) tells us the Reltio entity family.
      if (step.keyword === 'trigger' && step.provider === 'salesforce') {
        const dpl = step.dynamicPickListSelection || {};
        const sfFields = dpl.field_list || [];
        const sfFieldCount = Array.isArray(sfFields) ? sfFields.length : 0;
        if (sfFieldCount > 0) {
          // sobject_name → entity type hint
          const sobject = (dpl.sobject_name || step.input?.sobject_name || '');
          if (sobject) {
            _recipeEntityHints[recipeKey].push(sobject);
          }
          // Store as a pseudo-mapping: entity path derived from recipe name (text hints),
          // pillCount = number of Salesforce fields being synced (most accurate measure).
          // We use '*' as the entityTypePath since text-hint detection handles entity assignment.
          if (!_recipeReltioMappings[recipeKey]) _recipeReltioMappings[recipeKey] = [];
          _recipeReltioMappings[recipeKey].push({
            entityTypePath: sobject,          // used only for fallback matching
            attrShortNames: [],               // no Reltio attr names available at trigger
            pillCount: sfFieldCount,          // accurate field count from trigger schema
            fromTrigger: true,
          });
        }
      }

      const rawProvider = step.provider || '';

      // ── Collect Reltio-side entity type + attribute mappings ──────────────
      // The Workato Reltio connector mirrors the Reltio REST API payload format:
      //
      // Format A (REST API):
      //   { "type": "configuration/entityTypes/FinancialAccount",
      //     "attributes": {
      //       "configuration/entityTypes/FinancialAccount/attributes/Name": {"value":"{{1.Name}}"},
      //       "configuration/entityTypes/FinancialAccount/attributes/TaxId": {"value":"{{1.Fed_Tax_ID__c}}"}
      //     },
      //     "crosswalks": [{"type":"configuration/sources/Salesforce","value":"{{1.Id}}"}]
      //   }
      //
      // Format B (Integration Hub shorthand):
      //   { "object": "FinancialAccount", "crosswalkValue": "{{1.Id}}",
      //     "AddressLine1": "{{1.merchantDbaAddress1__c}}", ... }
      //
      // Format C (entityType key, older connector):
      //   { "entityType": "configuration/entityTypes/FinancialAccount", ... }
      //
      // We scan the FULL serialised step input so deeply-nested keys are also found.
      {
        const inputObj = step.input || {};
        const inputJson = JSON.stringify(inputObj);

        const foundPaths = new Set();

        // ── Entity type detection ──────────────────────────────────────────
        // 1. Any key whose value is a "configuration/entityTypes/..." URI.
        //    Covers "type", "entityType", "entity_type", etc. at any depth.
        //    Crosswalk "type" values contain "sources" not "entityTypes" so
        //    they're safely excluded by the value filter.
        const etUriPattern = /"[^"]+"\s*:\s*"(configuration\/entityTypes\/[^"]+)"/g;
        let etMatch;
        while ((etMatch = etUriPattern.exec(inputJson)) !== null) {
          foundPaths.add(etMatch[1]);
        }

        // 2. "object" key with a bare CamelCase/PascalCase entity name (Format B)
        const objectVal = String(inputObj.object || '');
        if (objectVal && (objectVal.includes('/') || /^[A-Z][a-zA-Z0-9]+$/.test(objectVal))) {
          foundPaths.add(objectVal);
        }

        if (foundPaths.size > 0) {
          if (!_recipeReltioMappings[recipeKey]) _recipeReltioMappings[recipeKey] = [];

          // ── Attribute short name extraction ────────────────────────────────
          const attrShortNames = new Set();

          // Source 1: full Reltio attribute URI keys at any nesting depth
          //   "configuration/entityTypes/X/attributes/ShortName": ...
          const attrUriRe = /configuration\/entityTypes\/[^/]+\/attributes\/([^/"]+)/g;
          let am;
          while ((am = attrUriRe.exec(inputJson)) !== null) {
            attrShortNames.add(am[1].toLowerCase());
          }

          // Source 2: top-level non-control keys in Format B
          //   { "object": "FinancialAccount", "AddressLine1": "{{1.Addr}}", ... }
          const CONTROL_KEYS = new Set([
            'object', 'objectType', 'crosswalkValue', 'crosswalks', 'type',
            'since', 'limit', 'offset', 'entity_type', 'entityType',
            'entityTypeUri', 'poll_interval', 'start_time',
            'trigger_poll_interval', 'since_field', 'dedup_key',
            'batch_size', 'page_size', 'attributes',
          ]);
          Object.keys(inputObj).forEach(k => {
            if (!CONTROL_KEYS.has(k)) attrShortNames.add(k.toLowerCase());
          });

          // Source 3: attribute short-names from the "attributes" sub-object
          //   { "attributes": { "configuration/.../attributes/Name": {...} } }
          const attrsObj = inputObj.attributes;
          if (attrsObj && typeof attrsObj === 'object') {
            Object.keys(attrsObj).forEach(k => {
              const seg = k.split('/').pop();
              if (seg) attrShortNames.add(seg.toLowerCase());
            });
          }

          // Count distinct data pills = distinct source fields being mapped
          const pills = new Set((inputJson.match(/\{\{[^}]+\}\}/g) || []));

          foundPaths.forEach(entityTypePath => {
            _recipeReltioMappings[recipeKey].push({
              entityTypePath,
              attrShortNames: [...attrShortNames],
              pillCount: pills.size,
            });
          });
        }
      }

      const sysLabel = normalizeProvider(rawProvider);

      if (sysLabel) {
        const key = sysLabel.toLowerCase();
        if (!sysByKey[key]) {
          sysByKey[key] = {
            label: sysLabel,
            provider: rawProvider,
            inboundSet: new Set(),
            outboundSet: new Set(),
            steps: [],
            fieldMappings: []
          };
        }
        const sys = sysByKey[key];
        const dir = classifyStepDirection(step);
        const recipeKey = `${projectName} / ${recipeName}`;
        if (dir === 'outbound') sys.outboundSet.add(recipeKey);
        else                    sys.inboundSet.add(recipeKey);

        sys.steps.push({
          project: projectName, recipe: recipeName,
          title: step.title || step.name || '',
          name: step.name || '',
          direction: dir,
          input: step.input || {}
        });

        // Extract field mappings from step input
        if (step.input && typeof step.input === 'object') {
          const SKIP = new Set(['object', 'since', 'entityType', 'type', 'limit', 'offset',
            'since_field', 'poll_interval', 'start_time', 'trigger_poll_interval']);
          function extractFields(obj, group) {
            Object.entries(obj || {}).forEach(([k, v]) => {
              if (SKIP.has(k)) return;
              if (v && typeof v === 'object' && !Array.isArray(v)) {
                extractFields(v, group || k);
              } else {
                sys.fieldMappings.push({
                  systemField: k, value: String(v ?? ''),
                  direction: dir, recipe: recipeName,
                  project: projectName, group: group || null
                });
              }
            });
          }
          extractFields(step.input, null);
        }
      }

      // Recurse
      walkSteps(step.block || step.actions || step.steps || step.children || [], recipeName, projectName);
    });
  }

  // Reset and rebuild recipeActiveMap as a side-effect
  recipeActiveMap      = {};
  _recipeEntityHints   = {};
  _recipeReltioMappings = {};

  Object.entries(flatProjects).forEach(([proj, recipes]) => {
    (recipes || []).forEach(r => {
      const data   = r.data || r;
      const name   = r.name || 'Unknown Recipe';
      const active = r.active !== false; // true unless explicitly false
      const mapKey = `${proj} / ${name}`;
      recipeActiveMap[mapKey] = active;
      // Add recipe name itself as a hint — recipe names are highly descriptive
      // e.g. "Batch Sync from Salesforce to Reltio - Account(Financial Account)"
      if (!_recipeEntityHints[mapKey]) _recipeEntityHints[mapKey] = [];
      _recipeEntityHints[mapKey].push(name);
      const roots = data.code ? [data.code]
        : Array.isArray(data.steps)   ? data.steps
        : Array.isArray(data.block)   ? data.block
        : Array.isArray(data.actions) ? data.actions : [];
      walkSteps(roots, name, proj);
    });
  });

  return Object.values(sysByKey).map(s => {
    const inC = s.inboundSet.size, outC = s.outboundSet.size;
    const direction = (inC > 0 && outC > 0) ? 'Bidirectional'
      : outC > 0 ? 'Outbound' : 'Inbound';
    return {
      ...s,
      inboundRecipes:  [...s.inboundSet],
      outboundRecipes: [...s.outboundSet],
      totalRecipes: new Set([...s.inboundSet, ...s.outboundSet]).size,
      direction
    };
  });
}

// ── System-agnostic color palette ───────────────────────────────────────────
const const_SYS_COLORS = [
  { bg: '#1e3a8a', text: '#93c5fd', border: '#3b82f6' },
  { bg: '#155e75', text: '#67e8f9', border: '#06b6d4' },
  { bg: '#4c1d95', text: '#c4b5fd', border: '#8b5cf6' },
  { bg: '#78350f', text: '#fcd34d', border: '#f59e0b' },
  { bg: '#064e3b', text: '#6ee7b7', border: '#10b981' },
  { bg: '#831843', text: '#f9a8d4', border: '#ec4899' },
  { bg: '#1c2a3a', text: '#cbd5e1', border: '#64748b' },
  { bg: '#3b1f5a', text: '#e9d5ff', border: '#a855f7' },
  { bg: '#1a3a2a', text: '#86efac', border: '#22c55e' },
  { bg: '#3a1a1a', text: '#fca5a5', border: '#ef4444' },
  { bg: '#2a2a1a', text: '#fef08a', border: '#eab308' },
  { bg: '#0c4a6e', text: '#7dd3fc', border: '#38bdf8' },
];
// NOTE: 'const_SYS_COLORS' intentionally uses underscore to avoid reserved word collision
function systemColor(label) {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  return const_SYS_COLORS[Math.abs(h) % const_SYS_COLORS.length];
}

// ── Canonical system list: config sources enriched with recipe data ──────────

// Match a raw recipe connection to a config source (fuzzy)
function _matchSourceToConnection(src) {
  if (!recipeConnections || !recipeConnections.length) return null;
  const srcLabel   = src.label.toLowerCase().replace(/[^a-z0-9]/g, '');
  const srcAbbr    = (src.abbreviation || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const srcUriKey  = (src.uri || '').split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  return recipeConnections.find(conn => {
    const cl = conn.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cp = (conn.provider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return cl === srcLabel || cl.includes(srcLabel) || srcLabel.includes(cl) ||
           cp === srcAbbr || cp === srcUriKey || cl === srcUriKey;
  }) || null;
}

// Returns one entry per config source, enriched with any recipe connection data.
// Config source list is authoritative — always the same 10 (or however many are in config).
function getAvailableSystems() {
  if (!configParser) return (recipeConnections || []);

  return configParser.sources.map(src => {
    const conn = _matchSourceToConnection(src);
    return {
      label:          src.label,
      abbreviation:   src.abbreviation || src.label.substring(0, 6),
      provider:       (conn && conn.provider) || src.abbreviation || src.label,
      uri:            src.uri,
      direction:      conn ? conn.direction : 'Inbound',
      inboundRecipes: conn ? conn.inboundRecipes  : [],
      outboundRecipes:conn ? conn.outboundRecipes : [],
      totalRecipes:   conn ? conn.totalRecipes    : 0,
      steps:          conn ? conn.steps           : [],
      fieldMappings:  conn ? conn.fieldMappings   : [],
      fromConfig:     true,
      hasRecipes:     !!conn,
    };
  });
}

// Recipe connections NOT matched to any config source (for "Other" section in registry)
function getUnmatchedConnections() {
  if (!recipeConnections) return [];
  const configSrcLabels = configParser
    ? new Set(configParser.sources.map(s => s.label.toLowerCase().replace(/[^a-z0-9]/g, '')))
    : new Set();
  return recipeConnections.filter(conn => {
    const cl = conn.label.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !configSrcLabels.has(cl) &&
           !configParser?.sources.some(src => {
             const sl = src.label.toLowerCase().replace(/[^a-z0-9]/g, '');
             return cl.includes(sl) || sl.includes(cl);
           });
  });
}

// Derive a field name for a given system + Reltio attribute
function getSystemFieldName(systemLabel, attrLabel) {
  // Check recipe-derived field mappings first
  const src  = configParser?.sources.find(s => s.label === systemLabel);
  const conn = src ? _matchSourceToConnection(src) : (recipeConnections || []).find(c => c.label === systemLabel);
  if (conn && conn.fieldMappings.length) {
    const attrNorm = attrLabel.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = conn.fieldMappings.find(m => {
      const fn = m.systemField.toLowerCase().replace(/[^a-z0-9]/g, '');
      return fn === attrNorm || fn.includes(attrNorm) || attrNorm.includes(fn);
    });
    if (match) return match.systemField;
  }
  // Fallback derivation based on known system naming conventions
  const snake  = attrLabel.toLowerCase().replace(/[\s/]+/g, '_').replace(/[^a-z0-9_]/g, '');
  const pascal = attrLabel.replace(/(?:^|[\s/])(\w)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
  const sl = systemLabel.toLowerCase();
  if (sl.includes('salesforce')) return pascal;
  if (sl.includes('servicenow')) return snake;
  if (sl.includes('workday'))    return 'WKD_' + snake.toUpperCase();
  if (sl.includes('sap'))        return snake.toUpperCase().substring(0, 8);
  if (sl.includes('netsuite'))   return 'NS_' + pascal;
  if (sl.includes('dynamics'))   return pascal;
  if (sl.includes('hubspot'))    return snake;
  return snake;
}

// Tab management (consolidated)

// Returns true if a system has at least one step from an active recipe
function isSourceActive(sys) {
  if (!sys.hasRecipes) return false;
  if (!Object.keys(recipeActiveMap).length) return true; // no map built yet → assume active
  return (sys.steps || []).some(step => {
    const key = `${step.project} / ${step.recipe}`;
    return recipeActiveMap[key] !== false;
  });
}

// ── Recipe → Entity/Attribute Index ──────────────────────────────────────────
// Returns: { sourceLabel → { entities: Set<entityLabel>, attrCounts: {}, active: bool } }
// or null when no recipe data is available.
function buildRecipeEntityIndex() {
  if (!configParser || !recipeConnections || !recipeConnections.length) return null;

  const entityLabels = configParser.entities.map(e => e.label);
  const entityLower  = entityLabels.map(e => e.toLowerCase());
  const activeOnly   = !_archShowInactive;

  // ── Build attribute crosswalk lookup from config ───────────────────────────
  // attrShortLower → Set<entityLabel>
  // e.g. "addressline1" → { "Organization", "Location" }
  // This is the config-level ground truth for which entities share an attribute.
  const attrToEntities = {}; // attrShortNameLower → Set<entityLabel>
  const entityAttrSet  = {}; // entityLabel → Set<attrShortNameLower>
  configParser.entities.forEach(entity => {
    if (!entityAttrSet[entity.label]) entityAttrSet[entity.label] = new Set();
    // Walk flat attribute list (already flattened by extractAttributesRecursively)
    configParser.attributes
      .filter(a => a.entity === entity.label)
      .forEach(a => {
        // Short name = last segment of URI
        const short = (a.uri || '').split('/').pop().toLowerCase();
        if (!short) return;
        entityAttrSet[entity.label].add(short);
        if (!attrToEntities[short]) attrToEntities[short] = new Set();
        attrToEntities[short].add(entity.label);
      });
  });

  // Match a Reltio entityType URI to a configured entity label.
  function matchEntityFromPath(path) {
    if (!path) return null;
    const segment  = path.split('/').pop();
    const segNorm  = segment.toLowerCase();
    const segWords = segment.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    let hit = entityLabels.find(el => el.toLowerCase().replace(/\s+/g, '') === segNorm);
    if (hit) return hit;
    hit = entityLabels.find(el => el.toLowerCase() === segWords);
    if (hit) return hit;
    hit = entityLabels.find(el => {
      const elNorm = el.toLowerCase().replace(/\s+/g, '');
      return segNorm.includes(elNorm) || elNorm.includes(segNorm);
    });
    if (hit) return hit;
    hit = entityLabels.find(el => segWords.includes(el.toLowerCase()));
    return hit || null;
  }

  // Text-based fallback (recipe name / step titles) — word-boundary safe.
  function detectEntities(text) {
    const found = new Set();
    const normalized = (text || '')
      .toLowerCase()
      .replace(/[_\-/\\.,;:()<>[\]{}|+=#~`!@$%^&*]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    entityLabels.forEach((el, i) => {
      const escaped = entityLower[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?:^|\\s)' + escaped + '(?:\\s|$)');
      if (re.test(normalized)) found.add(el);
    });
    return found;
  }

  const index = {};

  getAvailableSystems().forEach(sys => {
    if (!sys.hasRecipes) return;

    const sysIsActive = isSourceActive(sys);
    if (activeOnly && !sysIsActive) return;

    // entities this source writes to, and how many attrs per entity
    const entities   = new Set();
    const attrCounts = {}; // entityLabel → count of distinct attribute short names imported

    const allRecipeKeys = new Set([
      ...(sys.inboundRecipes  || []),
      ...(sys.outboundRecipes || []),
    ]);

    allRecipeKeys.forEach(recipeKey => {
      if (activeOnly && recipeActiveMap[recipeKey] === false) return;

      const reltioMappings = _recipeReltioMappings[recipeKey] || [];

      // ── PASS 1: Text hints — ALWAYS run ───────────────────────────────────
      // Recipe names like "Batch Sync from SFDC - Account(Financial Account)"
      // and step titles like "Create Financial Account in Reltio" reliably
      // identify the target entity regardless of recipe JSON format.
      (_recipeEntityHints[recipeKey] || []).forEach(text =>
        detectEntities(text).forEach(e => entities.add(e))
      );

      // ── PASS 2: Reltio step attribute crosswalk — when available ──────────
      // Use entityType URIs and attribute short names for precise matching
      // and accurate attribute counts.
      if (reltioMappings.length > 0) {
        // If a Salesforce trigger was found, its field_list count is the accurate
        // measure of fields being synced. Discard pill counts from downstream
        // Reltio connector steps (relations, lookups, deletes) which inflate the
        // number because they reference the same data pills many times.
        const hasTriggerCounts = reltioMappings.some(m => m.fromTrigger);

        reltioMappings.forEach(({ entityTypePath, attrShortNames, pillCount, fromTrigger }) => {
          const directEntity = matchEntityFromPath(entityTypePath);
          if (directEntity) entities.add(directEntity);

          if (attrShortNames && attrShortNames.length > 0) {
            // Attribute-level crosswalk: credit every config entity that
            // has an attribute with this short name — handles the case where
            // e.g. AddressLine1 lives under both Organization and Location.
            attrShortNames.forEach(short => {
              const entitiesWithAttr = attrToEntities[short] || new Set();
              entitiesWithAttr.forEach(el => {
                entities.add(el);
                attrCounts[el] = (attrCounts[el] || 0) + 1;
              });
            });
          } else if (directEntity && pillCount > 0) {
            // Only use trigger-derived counts (accurate SF field count).
            // Skip non-trigger Reltio step pill counts — they are inflated because
            // the same data pills are referenced dozens of times across nested steps.
            if (fromTrigger || !hasTriggerCounts) {
              attrCounts[directEntity] = (attrCounts[directEntity] || 0) + pillCount;
            }
          }
        });
      }
    });

    if (entities.size > 0) {
      index[sys.label] = { entities, attrCounts, active: sysIsActive };
    }
  });

  return Object.keys(index).length ? index : null;
}

// ── Debug helpers ─────────────────────────────────────────────────────────────
// debugRecipeIndex()  — full entity mapping result
// debugRawRecipe(n)   — raw step structure of recipe #n (default 0)

window.debugRawRecipe = function(recipeIndex = 0) {
  const keys = Object.keys(recipeActiveMap);
  if (!keys.length) { console.log('No recipes loaded'); return; }
  const key = keys[recipeIndex];
  console.group(`Raw data for recipe [${recipeIndex}]: ${key}`);
  console.log('Active:', recipeActiveMap[key]);
  console.log('Reltio mappings:', _recipeReltioMappings[key] || 'NONE');
  console.log('Entity hints:', _recipeEntityHints[key] || 'NONE');
  console.groupEnd();
  console.log(`Total recipes: ${keys.length}. Call debugRawRecipe(n) for others.`);
};

window.debugRecipeIndex = function() {
  console.group('Recipe Entity Index Debug');
  const recipeMappingCount = Object.keys(_recipeReltioMappings).length;
  console.log(`Reltio mappings found in ${recipeMappingCount} recipe(s):`);
  Object.entries(_recipeReltioMappings).forEach(([key, mappings]) => {
    const active = recipeActiveMap[key];
    console.group(`  [${active ? 'ACTIVE' : 'inactive'}] ${key}`);
    mappings.forEach(m => {
      const attrs = m.attrShortNames && m.attrShortNames.length
        ? ` | attrs: ${m.attrShortNames.join(', ')}`
        : '';
      console.log(`    ${m.entityTypePath}  (${m.pillCount} pills${attrs})`);
    });
    console.groupEnd();
  });
  console.log(`\nHint-only recipes (no Reltio steps detected):`);
  Object.keys(_recipeEntityHints)
    .filter(k => !_recipeReltioMappings[k])
    .forEach(k => console.log(`  [${recipeActiveMap[k] ? 'ACTIVE' : 'inactive'}] ${k}`));
  const idx = buildRecipeEntityIndex();
  console.log('\nFinal entity index (attr-crosswalk applied):');
  if (idx) {
    Object.entries(idx).forEach(([src, { entities, attrCounts }]) => {
      console.log(`  ${src}:`, [...entities].map(e => `${e}(${attrCounts[e] || 0})`).join(', '));
    });
  } else {
    console.log('  (null — no recipes loaded or no config)');
  }
  console.groupEnd();
};

function renderTab(tabId) {
  // Always render the recipes tab, even if configParser is null
  if (tabId === 'recipes') {
    setTimeout(() => renderRecipes(), 0);
    return;
  }
  if (!configParser) return;
  if (tabId === 'architecture') renderArchitecture();
  else if (tabId === 'entities') renderEntityBrowser();
  else if (tabId === 'registry') { setTimeout(() => renderRegistry(), 0); }
  else if (tabId === 'lineage')  { setTimeout(() => renderLineage(),   0); }
}

function switchTab(tabId) {
  try {
    const buttons = document.querySelectorAll('.tab-button');
    const panels = document.querySelectorAll('.tab-panel');
    buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    panels.forEach(p => p.classList.toggle('active', p.id === tabId));

    const panel = document.getElementById(tabId);
    if (panel) panel.scrollTop = 0;

    // Defensive: ensure entity detail only shows inside the Entities tab.
    const entityDetailContainer = document.getElementById('entityDetail');
    const entityDetailContent = document.getElementById('entityDetailContent');
    if (tabId !== 'entities') {
      if (entityDetailContent) entityDetailContent.innerHTML = '';
      if (entityDetailContainer) entityDetailContainer.style.display = 'none';

      // Clear any selected / highlighted rows in the entity list to avoid lingering selection
      const entityTable = document.getElementById('entityTable');
      if (entityTable) {
        entityTable.querySelectorAll('tr').forEach(row => {
          row.classList.remove('selected', 'active', 'is-selected', 'row-selected', 'highlight');
          row.removeAttribute('aria-selected');
          row.removeAttribute('data-selected');
          row.style.outline = '';
          row.style.background = '';
        });
      }

      // Clear any stored selection index used by the UI (defensive)
      if (window._selectedEntityIndex !== undefined) window._selectedEntityIndex = null;
    } else {
      if (entityDetailContainer) entityDetailContainer.style.display = 'flex';
    }

    renderTab(tabId);
  } catch (err) {
    console.error('switchTab error:', err);
  }
}

// Expose for inline handlers
window.switchTab = switchTab;

// Diagnostic click tracer (capture phase) - stores last elements stack at the click point
window.lastClickTrace = null;
document.addEventListener('click', (e) => {
  try {
    const tab = e.target.closest && e.target.closest('.tab-button');
    if (tab && tab.dataset && tab.dataset.tab) {
      // Prevent other handlers from interfering and call centralized switchTab
      e.preventDefault();
      e.stopPropagation();
      switchTab(tab.dataset.tab);
      return;
    }

    // Save elements under the pointer for debugging overlays
    const elems = document.elementsFromPoint(e.clientX, e.clientY).map(el => {
      const style = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        id: el.id || null,
        classes: el.className || null,
        zIndex: style.zIndex,
        pointerEvents: style.pointerEvents
      };
    });
    window.lastClickTrace = {
      time: Date.now(),
      x: e.clientX,
      y: e.clientY,
      targetTag: e.target.tagName,
      elementsAtPoint: elems
    };
  } catch (err) {
    console.error('click tracer error:', err);
  }
}, true);

// Keyboard shortcuts: Alt+1..6 navigate tabs (handy for testing)
document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const map = { '1': 'architecture', '2': 'entities', '3': 'recipes', '4': 'registry', '5': 'lineage' };
  if (map[e.key]) {
    e.preventDefault();
    switchTab(map[e.key]);
  }
});

// Notification system
function showNotification(message) {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.classList.remove('hidden');
  setTimeout(() => notification.classList.add('hidden'), 3200);
}

// File upload handler
document.getElementById('configFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 52_428_800) { showNotification('✗ Config file too large (max 50 MB)'); return; }
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    configParser = new ReltioConfigParser(json);
    // Save to localStorage
    localStorage.setItem('reltioConfig', JSON.stringify(json));
    renderTab('architecture');
    showNotification('✓ Reltio configuration loaded successfully (' + configParser.entities.length + ' entities)');
  } catch (error) {
    showNotification('✗ Failed to parse configuration file');
    console.error(error);
  }
});

document.getElementById('loadSample').addEventListener('click', () => {
  loadSampleConfig();
});

async function loadSampleConfig() {
  try {
    const response = await fetch('sample-config.json');
    const json = await response.json();
    configParser = new ReltioConfigParser(json);
    localStorage.setItem('reltioConfig', JSON.stringify(json));
    renderTab('architecture');
    showNotification('✓ Sample configuration loaded');
  } catch (error) {
    showNotification('✗ Failed to load sample config');
    console.error(error);
  }
}

// Render Architecture
function renderArchitecture() {
  if (!configParser) {
    const diagEl = document.getElementById('architectureDiagram');
    if (diagEl) diagEl.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📤</div><div class="empty-state-title">No configuration loaded</div><div class="empty-state-body">Use <strong>Load Config</strong> to upload a Reltio L3 Data Model export JSON, or click <strong>Load Sample Config</strong> to explore with demo data.</div></div>';
    return;
  }
  updateMetrics();
  renderEntityGroups();
  renderIntegrationSystems();
  renderConfigFiles();
  renderArchitectureDiagram();
  setupArchitectureFilterHandlers();
  _wireArchInactiveToggle();
  _wireArchInactiveGroupsToggle();
}

function setupArchitectureFilterHandlers() {
  // Only attach handlers once to avoid duplicate listeners on repeated renders
  if (window._architectureFiltersInitialized) return;
  window._architectureFiltersInitialized = true;

  // Entity Groups — multi-select toggle
  document.getElementById('entityGroups')?.addEventListener('click', e => {
    const item = e.target.closest('.sidebar-item[data-filter-type="group"]');
    if (!item) return;
    const val = item.dataset.filterValue;
    if (!val) return;
    if (_archGroupFilter.has(val)) _archGroupFilter.delete(val);
    else _archGroupFilter.add(val);
    renderEntityGroups();
    renderIntegrationSystems();
    renderArchitectureDiagram();
  });

  // Integration Systems — multi-select toggle
  document.getElementById('integrationSystems')?.addEventListener('click', e => {
    const item = e.target.closest('.sidebar-item[data-filter-type="source"]');
    if (!item) return;
    const val = item.dataset.filterValue;
    if (!val) return;
    if (_archSourceFilter.has(val)) _archSourceFilter.delete(val);
    else _archSourceFilter.add(val);
    renderEntityGroups();
    renderIntegrationSystems();
    renderArchitectureDiagram();
  });

  // Config Files — clear all filters
  document.getElementById('configFiles')?.addEventListener('click', e => {
    if (!e.target.closest('.sidebar-item')) return;
    _archGroupFilter.clear();
    _archSourceFilter.clear();
    renderEntityGroups();
    renderIntegrationSystems();
    renderArchitectureDiagram();
  });
}

function _setMetricCardHealth(cardId, pct) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.classList.remove('metric-health--green', 'metric-health--yellow', 'metric-health--red');
  if (pct === null || pct === undefined) return;
  card.classList.add(pct >= 80 ? 'metric-health--green' : pct >= 50 ? 'metric-health--yellow' : 'metric-health--red');
}

function updateMetrics() {
  const total = configParser.entities.length;
  document.getElementById('totalEntities').textContent = total;

  // -- Integration Coverage: % of entities with ≥1 active source recipe ----------
  const recipeIdx = buildRecipeEntityIndex();
  const coveredEntityLabels = new Set();
  if (recipeIdx) {
    Object.values(recipeIdx).forEach(({ entities: ents }) => ents.forEach(e => coveredEntityLabels.add(e)));
  }
  const integrationCovPct = total > 0 ? Math.round((coveredEntityLabels.size / total) * 100) : null;
  const integEl = document.getElementById('totalAttributes');
  if (integEl) {
    integEl.textContent = recipeIdx ? `${integrationCovPct}%` : '—';
    _setMetricCardHealth('metricCard-integration', integrationCovPct);
  }

  // -- Survivorship Coverage: % of entities with ≥1 survivorship rule ----------
  const withSurv = configParser.entities.filter(e => e.survivorshipGroupCount > 0).length;
  const survPct  = total > 0 ? Math.round((withSurv / total) * 100) : null;
  const survEl   = document.getElementById('recipeCount');
  if (survEl) {
    survEl.textContent = `${survPct ?? 0}%`;
    _setMetricCardHealth('metricCard-survivorship', survPct);
  }

  // -- Active Sources -------------------------------------------------------
  const sysEl = document.getElementById('connectedSystems');
  if (sysEl) {
    const activeSystems = recipeIdx ? Object.keys(recipeIdx).length : configParser.sources.length;
    sysEl.textContent = activeSystems;
  }

  // -- Orphaned Entities (in config but no recipe maps to them) --------------
  const orphanEl = document.getElementById('orphanedEntities');
  if (orphanEl) {
    if (recipeIdx) {
      const orphaned = configParser.entities.filter(e => !coveredEntityLabels.has(e.label)).length;
      orphanEl.textContent = orphaned;
      const card = document.getElementById('metricCard-orphaned');
      if (card) {
        card.classList.remove('metric-health--green', 'metric-health--yellow', 'metric-health--red');
        card.classList.add(orphaned === 0 ? 'metric-health--green' : orphaned <= 5 ? 'metric-health--yellow' : 'metric-health--red');
      }
    } else {
      orphanEl.textContent = '—';
    }
  }
}

function renderEntityGroups() {
  const recipeIdx = buildRecipeEntityIndex();
  const hasRecipeData = recipeConnections && recipeConnections.length > 0;

  // Build group info: total count + whether any entity in the group has recipe coverage
  const groupInfo = {};
  configParser.entities.forEach(e => {
    const g = e.label.split(' ')[0];
    if (!groupInfo[g]) groupInfo[g] = { total: 0, hasRecipes: false };
    groupInfo[g].total++;
    if (recipeIdx) {
      const coveredByRecipe = Object.values(recipeIdx).some(d => d.entities.has(e.label));
      if (coveredByRecipe) groupInfo[g].hasRecipes = true;
    }
  });

  const allGroupEntries  = Object.entries(groupInfo);
  const activeEntries    = allGroupEntries.filter(([, g]) => !hasRecipeData || g.hasRecipes);
  const inactiveEntries  = allGroupEntries.filter(([, g]) => hasRecipeData && !g.hasRecipes);
  const showInactiveG    = _archShowInactiveGroups;
  const visibleEntries   = showInactiveG ? allGroupEntries : activeEntries;

  // Update toggle button
  const toggleBtn = document.getElementById('archInactiveGroupsToggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('arch-inactive-toggle--on', showInactiveG);
    toggleBtn.textContent = showInactiveG ? 'Hide Inactive' : `Show Inactive (${inactiveEntries.length})`;
  }

  const html = visibleEntries.map(([group, info]) => {
    const isSelected  = _archGroupFilter.has(group);
    const isInactive  = hasRecipeData && !info.hasRecipes;
    const badgeStyle  = isInactive
      ? 'background:rgba(100,116,139,0.15);color:#64748b;font-style:italic;'
      : 'background:rgba(56,189,248,0.12);color:#38bdf8;';
    const dimStyle    = isInactive ? 'opacity:0.45;' : '';
    return `<div class="sidebar-item${isSelected ? ' active' : ''}" style="cursor:pointer;${dimStyle}"
      data-filter-type="group" data-filter-value="${escapeHtml(group)}">
      ${escapeHtml(group)} <span class="badge" style="${badgeStyle}">${info.total}</span>
    </div>`;
  }).join('');

  const el = document.getElementById('entityGroups');
  if (el) el.innerHTML = html || '<div style="color:var(--muted);">No entity groups</div>';
}

function renderIntegrationSystems() {
  const allSystems = getAvailableSystems();
  const hasRecipeData = recipeConnections && recipeConnections.length > 0;

  // Determine active/inactive for each system
  const withStatus = allSystems.map(sys => ({
    ...sys,
    isActive: !hasRecipeData || isSourceActive(sys),
  }));

  const activeSystems   = withStatus.filter(s => s.isActive);
  const inactiveSystems = withStatus.filter(s => !s.isActive);
  const showInactive    = _archShowInactive;
  const visibleSystems  = showInactive ? withStatus : activeSystems;

  // Update toggle button state
  const toggleBtn = document.getElementById('archInactiveToggle');
  if (toggleBtn) {
    toggleBtn.classList.toggle('arch-inactive-toggle--on', showInactive);
    toggleBtn.textContent = showInactive ? 'Hide Inactive' : `Show Inactive (${inactiveSystems.length})`;
  }

  const html = visibleSystems.map(sys => {
    const cl = systemColor(sys.label);
    const dirIcon = sys.direction === 'Outbound' ? '\u2191' :
                    sys.direction === 'Bidirectional' ? '\u21c4' : '\u2193';
    const activeBadge = hasRecipeData && !sys.isActive
      ? '<span class="badge arch-inactive-badge">inactive</span>'
      : sys.hasRecipes
        ? `<span class="badge" style="background:rgba(56,189,248,0.12);color:#38bdf8;margin-left:0.3rem;">${sys.totalRecipes}</span>`
        : '<span class="badge" style="background:rgba(100,116,139,0.1);color:#475569;">config</span>';
    const itemStyle = hasRecipeData && !sys.isActive
      ? `cursor:pointer;border-left:2px solid ${cl.border};opacity:0.45;`
      : `cursor:pointer;border-left:2px solid ${cl.border};`;
    const isSelected = _archSourceFilter.has(sys.label);
    return `<div class="sidebar-item${isSelected ? ' active' : ''}" style="${itemStyle}" data-filter-type="source" data-filter-value="${escapeHtml(sys.label)}">
      <span style="color:${cl.border};margin-right:0.3rem;">${dirIcon}</span>
      ${escapeHtml(sys.label)} ${activeBadge}
    </div>`;
  }).join('');

  const el = document.getElementById('integrationSystems');
  if (el) el.innerHTML = html || '<div class="sidebar-item" style="color:var(--muted);">Load a config to see systems</div>';
}

function _wireArchInactiveToggle() {
  const btn = document.getElementById('archInactiveToggle');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _archShowInactive = !_archShowInactive;
    renderIntegrationSystems();
    renderArchitectureDiagram();
  });
}

function _wireArchInactiveGroupsToggle() {
  const btn = document.getElementById('archInactiveGroupsToggle');
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _archShowInactiveGroups = !_archShowInactiveGroups;
    renderEntityGroups();
    renderArchitectureDiagram();
  });
}

function renderConfigFiles() {
  const fileInfo = [
    { label: 'Entities', value: configParser.entities.length },
    { label: 'Attributes', value: configParser.attributes.length },
    { label: 'Relationships', value: configParser.relationships.length },
    { label: 'Sources', value: configParser.sources.length }
  ];
  const html = fileInfo.map(f => `<div class="sidebar-item" style="cursor: pointer;">📊 ${f.label} <span class="badge">${f.value}</span></div>`).join('');
  const lastLoaded = '<div class="sidebar-item" style="cursor: pointer;">✓ Last loaded: ' + new Date().toLocaleTimeString() + '</div>';
  document.getElementById('configFiles').innerHTML = html + lastLoaded;
}

function renderArchitectureDiagram() {
  if (!configParser) return;

  // Delegate to model (entity-relationship) view when mode is set
  if (_archDiagramMode === 'model') {
    renderRelationshipDiagram();
    return;
  }

  const sanitize = (str) => str
    .replace(/&/g, ' and ')
    .replace(/[<>]/g, '')
    .replace(/"/g, "'")
    .trim();

  // Build recipe-derived entity index (null = no recipes loaded)
  const recipeIdx = buildRecipeEntityIndex();
  const hasRecipes = !!recipeIdx;
  const hasRecipeData = recipeConnections && recipeConnections.length > 0;

  // ── Base pools: apply active/inactive visibility ──────────────────────────
  // Active source systems
  let baseSystems = getAvailableSystems().map(sys => ({
    ...sys,
    isActive: !hasRecipeData || isSourceActive(sys),
  }));
  if (!_archShowInactive) {
    baseSystems = baseSystems.filter(s => s.isActive || !s.hasRecipes);
  }

  // Active entity labels (entities referenced by at least one active recipe source)
  const recipeActiveEntityLabels = new Set();
  if (hasRecipes) {
    Object.values(recipeIdx).forEach(({ entities: ents }) => ents.forEach(e => recipeActiveEntityLabels.add(e)));
  }
  let baseEntities = hasRecipeData && recipeActiveEntityLabels.size > 0 && !_archShowInactiveGroups
    ? configParser.entities.filter(e => recipeActiveEntityLabels.has(e.label))
    : configParser.entities;

  // ── Apply user multi-select filters ──────────────────────────────────────
  let systems  = [...baseSystems];
  let entities = [...baseEntities];

  const groupFilterActive  = _archGroupFilter.size  > 0;
  const sourceFilterActive = _archSourceFilter.size > 0;

  // Group filter: restrict entities to selected group(s)
  if (groupFilterActive) {
    entities = entities.filter(e => _archGroupFilter.has(e.label.split(' ')[0]));
  }

  // Source filter: restrict sources to selected source(s)
  if (sourceFilterActive) {
    systems = systems.filter(s => _archSourceFilter.has(s.label));
  }

  // Cross-filter: group selected → only show sources that feed those entities.
  // Exception: an explicitly user-selected source always stays regardless of
  // whether entity detection linked it to the group.
  if (groupFilterActive && hasRecipes) {
    const entitySet = new Set(entities.map(e => e.label));
    systems = systems.filter(s => {
      if (sourceFilterActive && _archSourceFilter.has(s.label)) return true; // explicit pick — never remove
      const d = recipeIdx[s.label];
      return d && [...d.entities].some(el => entitySet.has(el));
    });
  }

  // Cross-filter: source selected → only show entities those sources feed.
  // For explicitly-selected sources that have no entity link in the index yet,
  // fall back to showing all entities in the selected group (or all entities).
  if (sourceFilterActive && hasRecipes) {
    const fedEntities = new Set();
    systems.forEach(s => {
      const d = recipeIdx[s.label];
      if (d) d.entities.forEach(el => fedEntities.add(el));
    });
    if (fedEntities.size > 0) {
      entities = entities.filter(e => fedEntities.has(e.label));
    }
    // If none were detected (entity detection failed for these sources), keep
    // whatever entities are already in scope rather than showing an empty diagram.
  }

  // Slice entity list to keep diagram readable
  entities = entities.slice(0, 10);

  // Build entity index lookup
  const entityIdxMap = {};
  entities.forEach((e, i) => { entityIdxMap[e.label] = i; });

  // Sources subgraph — use the already-filtered systems list
  let diagramSystems = systems;
  if (hasRecipes && !groupFilterActive && !sourceFilterActive) {
    // Default (no filter): only show sources with confirmed entity connections in the index
    const filtered = systems.filter(s => recipeIdx[s.label]?.entities.size > 0);
    if (filtered.length) diagramSystems = filtered;
  }

  // ── Per-entity recipe field counts: sum across ALL diagramSystems ──────────
  // Computed here (after diagramSystems is finalised) so the entity node label
  // reflects exactly the sources actually drawn, and is additive as more
  // sources are selected.
  const entityRecipeAttrCounts = {};
  if (hasRecipes) {
    diagramSystems.forEach(s => {
      const d = recipeIdx[s.label];
      if (!d) return;
      Object.entries(d.attrCounts).forEach(([el, count]) => {
        entityRecipeAttrCounts[el] = (entityRecipeAttrCounts[el] || 0) + count;
      });
    });
  }

  let def = 'flowchart LR\n';

  // Entity subgraph
  def += '  subgraph entities["MDM Entity Types"]\n';
  entities.forEach((entity, idx) => {
    const safeLabel = sanitize(entity.label);
    // Entity node always shows total configured attribute count from schema.
    // Recipe field counts appear on the edge labels (arrows) between source and entity.
    const attrCount = entity.attributeCount ? ` (${entity.attributeCount} attrs)` : '';
    def += `    E${idx}["${safeLabel}${attrCount}"]\n`;
  });
  def += '  end\n\n';

  def += '  subgraph sources_group["Source Systems"]\n';
  diagramSystems.forEach((sys, idx) => {
    const safeLabel = sanitize(sys.label);
    const abbr = sys.abbreviation ? ` [${sys.abbreviation}]` : '';
    def += `    S${idx}["${safeLabel}${abbr}"]\n`;
  });
  def += '  end\n\n';

  // Draw connections
  if (hasRecipes) {
    // ── Real recipe-derived connections ──────────────────────────────────────
    let edgeCount = 0;
    diagramSystems.forEach((sys, sidx) => {
      const srcData = recipeIdx[sys.label];
      if (!srcData) return;
      srcData.entities.forEach(entityLabel => {
        const eidx = entityIdxMap[entityLabel];
        if (eidx === undefined) return;
        // Prefer DL mapping count (authoritative) over recipe-derived pill counts
        // which accumulate across many recipes and are inflated by nested data pill refs.
        const entityObj = entities[eidx];
        let attrCount = 0;
        if (_dataloaderMappings && entityObj?.uri) {
          const dlAttrs = _dataloaderMappings[entityObj.uri];
          attrCount = dlAttrs ? dlAttrs.length : (srcData.attrCounts[entityLabel] || 0);
        } else {
          attrCount = srcData.attrCounts[entityLabel] || 0;
        }
        const dirArrow = sys.direction === 'Outbound' ? ' -->' :
                         sys.direction === 'Bidirectional' ? ' <-->' : ' -->';
        const label = attrCount > 0 ? `|${attrCount} field${attrCount === 1 ? '' : 's'}|` : '';
        def += `  S${sidx}${dirArrow}${label} E${eidx}\n`;
        edgeCount++;
      });
    });
    if (!edgeCount) {
      // Fallback: sources that are in recipe connections but entity detection failed — connect all
      diagramSystems.forEach((sys, sidx) => {
        entities.forEach((_, eidx) => { def += `  S${sidx} --> E${eidx}\n`; });
      });
    }
  } else {
    // ── Config-only fallback (no recipe data) — draw dashed theoretical connections ──
    const entityCount = entities.length;
    const sourceCount = diagramSystems.length;
    if (entityCount > 0 && sourceCount > 0) {
      diagramSystems.forEach((_, sidx) => {
        for (let i = 0; i < entityCount; i++) {
          if (sourceCount === 1 || i % Math.max(2, Math.ceil(entityCount / sourceCount)) === sidx % entityCount) {
            def += `  S${sidx} -.-> E${i}\n`;
          }
        }
        if (sourceCount > 1 && sidx < entityCount) {
          def += `  S${sidx} -.-> E${sidx % entityCount}\n`;
        } else if (sourceCount > 1) {
          def += `  S${sidx} -.-> E${(sidx + Math.floor(entityCount / 2)) % entityCount}\n`;
        }
      });
    }
  }

  // Styling
  def += '  classDef entity fill:#1e40af,stroke:#38bdf8,color:#fff,stroke-width:2px\n';
  def += '  classDef source fill:#1e3a8a,stroke:#60a5fa,color:#fff\n';
  def += '  classDef sourceNoData fill:#1e293b,stroke:#475569,color:#475569\n';

  const entityClasses = entities.map((_, i) => `E${i}`).join(',');
  if (entityClasses) def += `  class ${entityClasses} entity\n`;

  diagramSystems.forEach((sys, sidx) => {
    const hasData = hasRecipes && recipeIdx[sys.label]?.entities.size > 0;
    def += `  class S${sidx} ${hasData || !hasRecipes ? 'source' : 'sourceNoData'}\n`;
  });

  // Mode banner
  const banner = document.getElementById('archDiagramBanner');
  if (banner) {
    if (hasRecipes) {
      const totalEdges = diagramSystems.reduce((t, s) => t + (recipeIdx[s.label]?.entities.size || 0), 0);
      banner.innerHTML = `<span class="arch-banner-recipe">\u2713 Recipe-driven</span> Showing ${diagramSystems.length} source${diagramSystems.length !== 1 ? 's' : ''} \u2192 ${entities.length} entities \u2014 ${totalEdges} real connections from imported recipes`;
      banner.style.display = 'block';
    } else {
      banner.innerHTML = `<span class="arch-banner-config">\u26a0 Config-only</span> Connections are theoretical \u2014 import recipes on the Reltio Recipes tab to see real data flows`;
      banner.style.display = 'block';
    }
  }

  window.diagramEntities = entities;
  window.diagramSources  = diagramSystems;

  renderMermaidDiagram('architectureDiagram', def);
}

// ─── Entity Relationship Diagram (Model View) ─────────────────────────────────
// Shows entity→entity connections using configParser.relationships.
function renderRelationshipDiagram() {
  if (!configParser) return;

  const sanitize = (str) => (str || '')
    .replace(/&/g, ' and ')
    .replace(/[<>"()\[\]{}|]/g, '')
    .trim();

  const rels = configParser.relationships || [];

  // Gather unique entity short-names
  const entityNames = new Set();
  rels.forEach(r => {
    const start = r.startObject?.objectTypeURI?.split('/').pop() || '';
    const end   = r.endObject?.objectTypeURI?.split('/').pop() || '';
    if (start) entityNames.add(start);
    if (end)   entityNames.add(end);
  });

  const entityArr = [...entityNames];
  const idxMap    = Object.fromEntries(entityArr.map((n, i) => [n, i]));

  let def = 'flowchart LR\n';
  entityArr.forEach((name, i) => {
    def += `  M${i}["${sanitize(name)}"]\n`;
  });

  rels.forEach(r => {
    const start = r.startObject?.objectTypeURI?.split('/').pop() || '';
    const end   = r.endObject?.objectTypeURI?.split('/').pop() || '';
    const label = sanitize(r.label || r.uri?.split('/').pop() || '');
    const si = idxMap[start], ei = idxMap[end];
    if (si === undefined || ei === undefined) return;
    const arrow = r.directionality === 'unidirectional' ? '-->' : '---';
    const edgeLabel = label ? `|${label}|` : '';
    def += `  M${si} ${arrow}${edgeLabel} M${ei}\n`;
  });

  def += '  classDef entityNode fill:#1e3a8a,stroke:#818cf8,color:#fff,stroke-width:2px\n';
  const allNodes = entityArr.map((_, i) => `M${i}`).join(',');
  if (allNodes) def += `  class ${allNodes} entityNode\n`;

  const banner = document.getElementById('archDiagramBanner');
  if (banner) {
    banner.innerHTML = `<span class="arch-banner-recipe">\u25c6 Model View</span> ` +
      `${entityArr.length} entity type${entityArr.length !== 1 ? 's' : ''}, ` +
      `${rels.length} relationship${rels.length !== 1 ? 's' : ''} — ` +
      `<a href="javascript:void(0)" onclick="_switchDiagramMode('flow')" style="color:#38bdf8;">Back to Flow View</a>`;
    banner.style.display = 'block';
  }

  renderMermaidDiagram('architectureDiagram', def);
}

window._switchDiagramMode = (mode) => {
  _archDiagramMode = mode;
  const btn = document.getElementById('archModelViewBtn');
  if (btn) btn.classList.toggle('btn-primary', mode === 'model');
  renderArchitectureDiagram();
};

// ─── Source × Entity Coverage Matrix ─────────────────────────────────────────
function renderCoverageMatrix() {
  if (!configParser) { showNotification('\u26a0 Load a config to view the coverage matrix'); return; }

  const recipeIdx = buildRecipeEntityIndex();
  const entities  = configParser.entities.slice(0, 30); // cap to keep table manageable
  const sources   = getAvailableSystems();

  let html = '<table class="cov-matrix-table"><thead><tr><th class="cov-matrix-th-fixed">Source</th>';
  entities.forEach(e => {
    html += `<th class="cov-matrix-th" title="${escapeHtml(e.label)}">${escapeHtml(e.label.split(' ').slice(-1)[0])}</th>`;
  });
  html += '</tr></thead><tbody>';

  sources.forEach(sys => {
    html += `<tr><td class="cov-matrix-td-label">${escapeHtml(sys.label)}</td>`;
    entities.forEach(entity => {
      const hasDL  = _dataloaderMappings && _dataloaderMappings[entity.uri];
      const dlCount = hasDL ? _dataloaderMappings[entity.uri].length : 0;
      const hasRecipe = recipeIdx && recipeIdx[sys.label]?.entities.has(entity.label);
      let cellClass = 'cov-cell--none';
      let cellText  = '';
      if (hasRecipe && dlCount > 0) { cellClass = 'cov-cell--full'; cellText = dlCount; }
      else if (hasRecipe)           { cellClass = 'cov-cell--recipe'; cellText = '✓'; }
      else if (dlCount > 0)         { cellClass = 'cov-cell--dl-only'; cellText = dlCount; }
      html += `<td class="cov-matrix-cell ${cellClass}" title="${escapeHtml(sys.label)} → ${escapeHtml(entity.label)}">${cellText}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table>';
  const content = document.getElementById('coverageMatrixContent');
  if (content) content.innerHTML = html;
  const modal = document.getElementById('coverageMatrixModal');
  if (modal) modal.style.display = 'flex';
}

function renderMermaidDiagram(elementId, definition) {
  const container = document.getElementById(elementId);
  if (!container) {
    console.error(`Container ${elementId} not found`);
    return;
  }
  
  container.innerHTML = '';
  
  // Validate the definition
  if (!definition || typeof definition !== 'string') {
    console.error('Invalid Mermaid definition', definition);
    return;
  }
  
  // Check for common issues
  if (definition.includes('&amp;') || definition.includes('&lt;') || definition.includes('&gt;')) {
    console.warn('WARNING: HTML entities detected in Mermaid definition. This may cause syntax errors.');
  }
  
  // Create mermaid diagram
  const mermaidContent = document.createElement('div');
  mermaidContent.className = 'mermaid';
  mermaidContent.textContent = definition;
  
  container.appendChild(mermaidContent);
  
  // Trigger mermaid rendering
  try {
    if (typeof mermaid !== 'undefined' && typeof mermaid.run === 'function') {
      mermaid.run();
    } else if (typeof mermaid !== 'undefined' && typeof mermaid.contentLoaded === 'function') {
      mermaid.contentLoaded();
    } else {
      console.error('Mermaid not available or no render function found');
    }
  } catch (error) {
    console.error('Error rendering Mermaid diagram:', error);
    container.innerHTML = '<div style="color: #ff6b6b; padding: 20px; background: #2a2a2a; border: 1px solid #ff6b6b; border-radius: 4px;">' +
      '<strong>Diagram Error:</strong><br/>' + error.message + '<br/><br/>' +
      '<strong>Definition:</strong><br/><pre style="font-size: 10px; overflow-x: auto;">' + 
      definition.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre></div>';
  }
  
  // Add click handler for diagram nodes
  setTimeout(() => {
    const svg = container.querySelector('svg');
    if (svg) {
      svg.addEventListener('click', (e) => {
        let target = e.target;
        while (target && target !== svg) {
          const dataId = target.getAttribute('data-id');
          if (dataId && (dataId.startsWith('E') || dataId.startsWith('S'))) {
            if (dataId.startsWith('E')) {
              const idx = parseInt(dataId.substring(1));
              if (window.diagramEntities && idx < window.diagramEntities.length) {
                // Ctrl+Click or right-click: Navigate to Entity Browser
                if (e.ctrlKey || e.metaKey) {
                  navigateToEntity(idx);
                } else {
                  // Normal click: Filter diagram and show quick view
                  const groupType = window.diagramEntities[idx].label.split(' ')[0];
                  applyArchitectureFilter('group', groupType);
                  showEntityQuickView(idx);
                }
              }
            } else if (dataId.startsWith('S')) {
              const idx = parseInt(dataId.substring(1));
              if (window.diagramSources && idx < window.diagramSources.length) {
                applyArchitectureFilter('source', window.diagramSources[idx].label);
              }
            }
            break;
          }
          target = target.parentElement;
        }
      });
    }
  }, 200);
}

// Entity Browser
function renderEntityBrowser() {
  if (!configParser) {
    const tbody = document.getElementById('entityTable');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state" style="border:none;"><div class="empty-state-icon">📤</div><div class="empty-state-title">No configuration loaded</div><div class="empty-state-body">Load a config file to browse entity types, attributes, and survivorship settings.</div></div></td></tr>';
    const countEl = document.getElementById('entityCount');
    if (countEl) countEl.textContent = '';
    return;
  }
  populateEntityFilterGroups();
  renderEntityTable();
}

function populateEntityFilterGroups() {
  const select = document.getElementById('filterGroups');
  const groups = [...new Set(configParser.entities.map(e => e.label.split(' ')[0]))];
  select.innerHTML = '<option value="">All Groups</option>' + 
    groups.map(g => `<option value="${g}">${g}</option>`).join('');
}

function renderEntityTable() {
  const tbody = document.getElementById('entityTable');
  if (!tbody) {
    console.error('Error: entityTable tbody not found');
    return;
  }
  
  const rows = configParser.entities.map((entity, idx) => {
    const attrCountHtml = `<a href="javascript:void(0)" onclick="event.stopPropagation(); showEntityDetail(${idx}); return false;" style="color:#38bdf8; cursor:pointer; text-decoration:underline; font-weight:bold;">${entity.attributeCount}</a>`;
    
    return `
    <tr onclick="showEntityDetail(${idx})" style="cursor:pointer; border-bottom: 1px solid rgba(148,163,184,0.1); transition: background 0.2s;">
      <td style="padding: 0.75rem;"><a onclick="event.stopPropagation(); showEntityDetail(${idx}); return false;" href="javascript:void(0)" title="${entity.description}" style="color:#38bdf8; text-decoration:none; cursor:pointer;">${entity.label}</a></td>
      <td style="padding: 0.75rem;">${entity.label.split(' ')[0]}</td>
      <td style="padding: 0.75rem; text-align:center;">${attrCountHtml}</td>
      <td style="padding: 0.75rem; text-align:center;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; margin-right:0.5rem;\"></span>${entity.relationshipCount}</td>
      <td style="padding: 0.75rem; text-align:center;"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; margin-right:0.5rem;\"></span>${entity.survivorshipGroupCount}</td>
      <td style="padding: 0.75rem;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>
    `;
  }).join('');
  
  tbody.innerHTML = rows;
  const resultCount = document.getElementById('entityCount');
  if (resultCount) {
    resultCount.textContent = `Showing ${configParser.entities.length} of ${configParser.entities.length} entities`;
  }
}

function showEntityDetail(entityIndex, forceShowUnused) {
  const entity = configParser.entities[entityIndex];
  if (!entity) return;

  // Clear persisted toggle state when switching to a different entity
  if (_entityDetailLastIdx !== entityIndex) {
    _entityDetailShowUnmapped = {};
    _entityDetailLastIdx = entityIndex;
  }

  const detail = document.getElementById('entityDetailContent');

  // ── Check recipe connectivity via the same index the architecture map uses ──
  // The Workato batch sync recipes map Salesforce fields to Reltio via the connector
  // UI, not raw JSON attribute keys. So individual Reltio attribute names are not
  // available in the recipe JSON. We use the pill/field count as a connectivity proxy,
  // which is the same number shown on the architecture map arrows.
  const recipeIdx = buildRecipeEntityIndex();
  let entityMappedFieldCount = 0;
  if (recipeIdx) {
    Object.values(recipeIdx).forEach(srcData => {
      if (srcData.entities.has(entity.label)) {
        entityMappedFieldCount += (srcData.attrCounts[entity.label] || 0);
      }
    });
  }
  const hasRecipes = entityMappedFieldCount > 0;

  // Dataloader attribute-level mappings (more precise than recipe pill counts)
  // Match by entity URI first; fall back to matching by entity label suffix
  // (e.g. DL key ends with "/Organization" and entity.label === "Organization")
  let _dlEntry = _dataloaderMappings ? (_dataloaderMappings[entity.uri] || null) : null;
  if (!_dlEntry && _dataloaderMappings) {
    // Fallback: find any DL key whose last path segment matches entity label
    const labelLower = entity.label.toLowerCase();
    const fallbackKey = Object.keys(_dataloaderMappings).find(
      k => k.split('/').pop().toLowerCase() === labelLower
    );
    if (fallbackKey) _dlEntry = _dataloaderMappings[fallbackKey];
  }
  const _dlMappedSet   = _dlEntry ? new Set(_dlEntry) : null;
  const _dlMappedCount = _dlEntry ? _dlEntry.length : 0;

  // Default: hide unmapped attrs when DL mappings are available; user can expand
  const showUnmapped = (_entityDetailShowUnmapped || {})[entityIndex] === true;
  const _unmappedCount = _dlMappedSet !== null ? entity.attributes.filter(a => !_dlMappedSet.has((a.uri || '').split('/').pop())).length : 0;
  const visibleAttrs  = _dlMappedSet !== null && !showUnmapped
    ? entity.attributes.filter(a => _dlMappedSet.has((a.uri || '').split('/').pop()))
    : entity.attributes;

  function buildAttrRows() {
    return visibleAttrs.map(attr => {
      const shortName = (attr.uri || '').split('/').pop();
      const statusDot = _dlMappedSet !== null
        ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:6px;vertical-align:middle;flex-shrink:0;" title="Loaded via Dataloader"></span>`
        : '';
      // RDM badge for enum attributes
      let rdmBadge = '';
      if (attr.type === 'enum') {
        const rdmTypeName = findRDMTypeForAttr(shortName);
        if (rdmTypeName && _rdmData[rdmTypeName]) {
          const rdmEntry = _rdmData[rdmTypeName];
          const sfVals   = rdmEntry.values.filter(v => v.sourceMappings?.Salesforce).length;
          const tip = `Lookup: ${rdmTypeName} — ${rdmEntry.values.length} values, ${sfVals} Salesforce mappings`;
          rdmBadge = `<span style="margin-left:0.4rem;font-size:0.7em;padding:0.1rem 0.4rem;border-radius:3px;background:rgba(99,102,241,0.15);color:#818cf8;border:1px solid rgba(99,102,241,0.3);cursor:default;" title="${escapeHtml(tip)}">${rdmEntry.values.length} values</span>`;
        }
      }
      return `<tr style="border-bottom:1px solid rgba(148,163,184,0.07);">
        <td style="padding:0.6rem 0.75rem;color:#e0e7ff;">${statusDot}${escapeHtml(attr.label || '')}${rdmBadge}</td>
        <td style="padding:0.6rem 0.75rem;color:#64748b;font-size:0.82em;">${escapeHtml(attr.type || 'string')}</td>
        <td style="padding:0.6rem 0.75rem;text-align:center;color:#10b981;">${attr.multiValue ? '✓' : '–'}</td>
        <td style="padding:0.6rem 0.75rem;font-size:0.75em;color:#475569;">${escapeHtml(shortName)}</td>
      </tr>`;
    }).join('');
  }

  function renderDetail() {
    const attrRows = buildAttrRows();

    detail.innerHTML = `
      <div style="padding:1.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.25rem;padding-bottom:1rem;border-bottom:2px solid #38bdf8;">
          <div>
            <h2 style="margin:0;color:#38bdf8;font-size:1.4em;">${escapeHtml(entity.label)}</h2>
            <p style="margin:0.4rem 0 0;color:#94a3b8;font-size:0.88em;">${escapeHtml(entity.description || 'No description available')}</p>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.35rem;">
            ${_dlMappedSet !== null
              ? `<span style="font-size:0.78em;padding:0.25rem 0.65rem;border-radius:999px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid #10b981;white-space:nowrap;" title="Attributes loaded for this entity via the Reltio Dataloader">${_dlMappedCount} of ${entity.attributeCount} attrs loaded</span>`
              : (_dataloaderMappings
                ? `<span style="font-size:0.78em;padding:0.25rem 0.65rem;border-radius:999px;background:rgba(71,85,105,0.12);color:#64748b;border:1px solid #334155;white-space:nowrap;" title="DL mappings loaded but no entry for this entity type">DL loaded — no match</span>`
                : `<span style="font-size:0.78em;padding:0.25rem 0.65rem;border-radius:999px;background:rgba(71,85,105,0.08);color:#475569;border:1px dashed #334155;white-space:nowrap;" title="Import DL mappings using the button above the entity list">No DL data</span>`)}
            ${hasRecipes && _dlMappedSet === null ? `<span style="font-size:0.78em;padding:0.25rem 0.65rem;border-radius:999px;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid #10b981;white-space:nowrap;">~${entityMappedFieldCount} fields synced</span>` : ''}
            ${_rdmData ? `<span style="font-size:0.78em;padding:0.25rem 0.65rem;border-radius:999px;background:rgba(99,102,241,0.1);color:#818cf8;border:1px solid rgba(99,102,241,0.3);white-space:nowrap;" title="Reference data loaded">RDM loaded</span>` : ''}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1.5rem;">
          <div style="display:flex;flex-direction:column;"><span style="color:#64748b;font-size:0.75em;text-transform:uppercase;margin-bottom:0.3rem;">Type</span><span style="color:#e0e7ff;font-weight:500;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</span></div>
          <div style="display:flex;flex-direction:column;"><span style="color:#64748b;font-size:0.75em;text-transform:uppercase;margin-bottom:0.3rem;">Total Attrs</span><span style="color:#e0e7ff;font-weight:500;">${entity.attributeCount}</span></div>
          <div style="display:flex;flex-direction:column;"><span style="color:#64748b;font-size:0.75em;text-transform:uppercase;margin-bottom:0.3rem;">Relationships</span><span style="color:#e0e7ff;font-weight:500;">${entity.relationshipCount}</span></div>
          <div style="display:flex;flex-direction:column;"><span style="color:#64748b;font-size:0.75em;text-transform:uppercase;margin-bottom:0.3rem;">Survivorship</span><span style="color:#e0e7ff;font-weight:500;">${entity.survivorshipGroupCount}</span></div>
          <div style="display:flex;flex-direction:column;"><span style="color:#64748b;font-size:0.75em;text-transform:uppercase;margin-bottom:0.3rem;">Match Groups</span><span style="color:#e0e7ff;font-weight:500;">${entity.matchGroupCount || 0}</span></div>
          <div style="display:flex;flex-direction:column;"><span style="color:#64748b;font-size:0.75em;text-transform:uppercase;margin-bottom:0.3rem;">Group</span><span style="color:#38bdf8;">${escapeHtml(entity.label.split(' ')[0])}</span></div>
        </div>

        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;padding-bottom:0.6rem;border-bottom:1px solid rgba(56,189,248,0.25);">
            <h3 style="margin:0;color:#38bdf8;font-size:1em;">Attributes
              <span style="font-size:0.8em;font-weight:400;color:#64748b;margin-left:0.5rem;">${_dlMappedSet !== null
                ? `(${_dlMappedCount} mapped${_unmappedCount > 0 && !showUnmapped ? `, ${_unmappedCount} unmapped hidden` : _unmappedCount > 0 ? `, ${_unmappedCount} unmapped` : ''})`
                : `(${entity.attributeCount} configured)`}</span>
            </h3>
            ${_dlMappedSet !== null && _unmappedCount > 0
              ? `<button onclick="window._toggleEntityUnmapped(${entityIndex})" style="font-size:0.75em;padding:0.2rem 0.7rem;border-radius:999px;border:1px solid rgba(148,163,184,0.3);background:${showUnmapped ? 'rgba(245,158,11,0.1)' : 'transparent'};color:${showUnmapped ? '#f59e0b' : '#64748b'};cursor:pointer;white-space:nowrap;">${showUnmapped ? '▲ Hide Unmapped' : `▼ Show Unmapped (${_unmappedCount})`}</button>`
              : ''}
          </div>
          ${_dataloaderMappings !== null && _dlMappedSet === null
            ? `<div style="font-size:0.77em;color:#475569;margin-bottom:0.75rem;padding:0.4rem 0.75rem;background:rgba(71,85,105,0.07);border-radius:4px;border-left:2px solid #334155;">No Dataloader mapping found for this entity type. Showing all configured attributes.</div>`
            : ''}
          ${_dlMappedSet !== null
            ? `<div style="font-size:0.78em;color:#64748b;margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(16,185,129,0.05);border-radius:4px;border-left:2px solid #10b981;"><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:5px;vertical-align:middle;"></span>Loaded via Dataloader — unmapped attributes hidden by default</div>`
            : (hasRecipes ? `<div style="font-size:0.78em;color:#64748b;margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(16,185,129,0.05);border-radius:4px;border-left:2px solid #10b981;">Salesforce syncs ~${entityMappedFieldCount} fields to this entity via active recipes. Import Dataloader mappings for attribute-level detail.</div>` : '')}
          ${entity.attributeCount > 0 ? `
          <div style="overflow-x:auto;">
            <table style="width:100%;font-size:0.88em;border-collapse:collapse;">
              <thead>
                <tr style="background:rgba(56,189,248,0.07);">
                  <th style="padding:0.5rem 0.75rem;text-align:left;color:#38bdf8;font-weight:600;">Attribute</th>
                  <th style="padding:0.5rem 0.75rem;text-align:left;color:#38bdf8;font-weight:600;">Type</th>
                  <th style="padding:0.5rem 0.75rem;text-align:center;color:#38bdf8;font-weight:600;width:80px;">Multi</th>
                  <th style="padding:0.5rem 0.75rem;text-align:left;color:#38bdf8;font-weight:600;">Short Name</th>
                </tr>
              </thead>
              <tbody>${attrRows || '<tr><td colspan="4" style="padding:1rem;color:#64748b;text-align:center;">No attributes defined.</td></tr>'}</tbody>
            </table>
          </div>` : '<p style="color:#64748b;">No attributes defined.</p>'}
        </div>
      </div>
    `;
  }

  const savedState = forceShowUnused !== undefined
    ? forceShowUnused
    : (_entityDetailShowUnmapped || {})[entityIndex] === true;
  renderDetail();

  // Make detail panel visible
  const entityDetailContainer = document.getElementById('entityDetail');
  if (entityDetailContainer) entityDetailContainer.style.display = 'flex';
}



// --- IndexedDB helpers for recipes persistence ---
const RECIPES_DB_NAME = 'reltioRecipesDB';
const RECIPES_STORE = 'recipes';

function openRecipesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RECIPES_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(RECIPES_STORE)) {
        db.createObjectStore(RECIPES_STORE);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveRecipesToDB(data) {
  const db = await openRecipesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECIPES_STORE], 'readwrite');
    const store = tx.objectStore(RECIPES_STORE);
    const req = store.put(data, 'recipesData');
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadRecipesFromDB() {
  const db = await openRecipesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECIPES_STORE], 'readonly');
    const store = tx.objectStore(RECIPES_STORE);
    const req = store.get('recipesData');
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// --- IndexedDB helpers for Dataloader mappings persistence ---
// ── RDM (Reference Data) helpers ──────────────────────────────────────────────
function parseRDMData(arr) {
  const result = {};
  for (const item of arr) {
    const typeName = (item.type || '').split('/').pop(); // e.g. "CompanyTypes"
    if (!typeName) continue;
    if (!result[typeName]) result[typeName] = { sources: new Set(), values: [] };
    const entry = result[typeName];
    const reltioMapping = (item.sourceMappings || []).find(m => m.source === 'Reltio');
    const reltioValue = reltioMapping?.values?.[0]?.value || item.code;
    const sourceMappings = {};
    for (const sm of (item.sourceMappings || [])) {
      if (sm.source === 'Reltio') continue;
      entry.sources.add(sm.source);
      for (const v of (sm.values || [])) {
        sourceMappings[sm.source] = v.value || v.code;
      }
    }
    entry.values.push({ code: item.code, reltioValue, sourceMappings, enabled: item.enabled !== false });
  }
  // Convert Set to Array for serialisation
  for (const t of Object.keys(result)) result[t].sources = [...result[t].sources];
  return result;
}

// Fuzzy match: given an attribute short name, find the best RDM lookup type.
// Strips "Type/Types/Status/Statuses" suffixes then tries substring/contains match.
function findRDMTypeForAttr(attrShortName) {
  if (!_rdmData || !attrShortName) return null;
  const norm = s => s.toLowerCase().replace(/types?$|statuses?$|s$/, '');
  const needle = norm(attrShortName);
  // Exact normalised match first
  for (const typeName of Object.keys(_rdmData)) {
    if (norm(typeName) === needle) return typeName;
  }
  // Substring: e.g. "OrganizationType" → needle="organizationtype" and "CompanyTypes" → norm="company"
  // Try: does type contain needle or needle contains type?
  for (const typeName of Object.keys(_rdmData)) {
    const hay = norm(typeName);
    if (hay.includes(needle) || needle.includes(hay)) return typeName;
  }
  return null;
}

async function saveRDMToDB(data) {
  const db = await openRecipesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECIPES_STORE], 'readwrite');
    const store = tx.objectStore(RECIPES_STORE);
    const req = store.put(data, 'rdmData');
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadRDMFromDB() {
  const db = await openRecipesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECIPES_STORE], 'readonly');
    const store = tx.objectStore(RECIPES_STORE);
    const req = store.get('rdmData');
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveDLMappingsToDB(attrsData, fieldMapsData) {
  const db = await openRecipesDB(); // reuse same DB
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECIPES_STORE], 'readwrite');
    const store = tx.objectStore(RECIPES_STORE);
    const req = store.put({ attrs: attrsData, fieldMaps: fieldMapsData }, 'dlMappingsData');
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadDLMappingsFromDB() {
  const db = await openRecipesDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([RECIPES_STORE], 'readonly');
    const store = tx.objectStore(RECIPES_STORE);
    const req = store.get('dlMappingsData');
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

// Parse the Reltio Dataloader API mappings response into two lookups:
// attrs:     { "configuration/entityTypes/Organization" → ["Name", "TaxID", ...] }
// fieldMaps: { "configuration/entityTypes/Organization" → { "TaxID": "TAXID", "Name": "ACCOUNTNAME", ... } }
function parseDataloaderMappings(arr) {
  const attrs = {};
  const fieldMaps = {};
  for (const mapping of arr) {
    if (mapping.mappingForObjectType !== 'ENTITIES') continue;
    const uri = mapping.objectTypeUri;
    if (!uri) continue;
    // Build col key → source column name lookup
    const colNames = {};
    for (const src of (mapping.mappingSummary?.sources || [])) {
      colNames[src.key] = src.name;
    }
    const attrsSet = new Set();
    const fMap = {};
    for (const entry of (mapping.mappingSummary?.attributes || [])) {
      const path = entry.path || '';
      // "attributes.Phone[0].Number" → "Phone" ; "attributes.FirstName" → "FirstName"
      const m = path.match(/^attributes\.([^[.]+)/);
      if (!m) continue;
      const shortName = m[1];
      attrsSet.add(shortName);
      // "=source('col.0')" → colNames['col.0'] → e.g. "TAXID"
      const colMatch = (entry.value || '').match(/=source\('(col\.\d+)'\)/);
      if (colMatch && colNames[colMatch[1]] && !fMap[shortName]) {
        fMap[shortName] = colNames[colMatch[1]]; // first top-level path wins
      }
    }
    attrs[uri]     = [...attrsSet].sort();
    fieldMaps[uri] = fMap;
  }
  return { attrs, fieldMaps };
}

// Reltio Recipes Tab Implementation (now uses IndexedDB)
async function renderRecipes() {
  const importBtn = document.getElementById('importRecipesBtn');
  const importInput = document.getElementById('importRecipesFolder');
  const projectsContainer = document.getElementById('recipesProjectsContainer');
  const diagramContainer = document.getElementById('recipeDiagramContainer');

  // Defensive: clear containers every time
  if (projectsContainer) projectsContainer.innerHTML = '';
  if (diagramContainer) diagramContainer.innerHTML = '';

  // Always reload from IndexedDB
  let recipesData = null;
  try {
    recipesData = await loadRecipesFromDB();
  } catch (err) {
    console.error('[recipes] Failed to load from IndexedDB:', err);
  }
  if (recipesData) {
    recipeConnections = extractRecipeConnections(recipesData);
    if (projectsContainer && diagramContainer) {
      renderProjectsAndRecipes(recipesData, projectsContainer, diagramContainer);
    }
  }

  // Attach import handler (only once)
  if (importBtn && importInput && !importBtn._handlerAttached) {
    importBtn._handlerAttached = true;
    importBtn.addEventListener('click', () => {
      importInput.value = '';   // reset so the same folder can be re-selected
      importInput.click();
    });
    importInput.addEventListener('change', async (e) => {
      const files = Array.from(importInput.files);
      if (!files.length) return;
      if (files.length > 600) {
        showNotification(`⚠ Large import: ${files.length} files. This may take a moment…`);
      }

      // Clear all existing UI immediately so old data is visually gone
      if (projectsContainer) projectsContainer.innerHTML = '<div style="color:var(--muted);padding:2rem;">Importing\u2026</div>';
      if (diagramContainer)  diagramContainer.innerHTML  = '';
      const detailPanel = document.getElementById('recipeStepDetailPanel');
      if (detailPanel) { detailPanel.style.display = 'none'; detailPanel.innerHTML = ''; }
      const flexLayout = document.getElementById('recipeFlexLayout');
      if (flexLayout) flexLayout.classList.remove('has-detail');

      // Parse the new folder from scratch (fresh object each time)
      const newRecipesData = await parseReltioRecipesFiles(files);

      // Persist to IndexedDB — put() fully replaces any prior data
      try {
        await saveRecipesToDB(newRecipesData);
      } catch (err) {
        console.error('[recipes] Failed to save recipesData to IndexedDB:', err);
      }

      recipeConnections = extractRecipeConnections(newRecipesData);
      // Count recipes and groups for user feedback
      const totalGroups = Object.keys(newRecipesData).length;
      const totalRecipes = Object.values(newRecipesData).reduce((t, projs) =>
        t + Object.values(projs || {}).reduce((s, arr) => s + (arr?.length || 0), 0), 0);
      renderProjectsAndRecipes(newRecipesData, projectsContainer, diagramContainer);
      showNotification(`\u2713 ${totalRecipes} recipe${totalRecipes !== 1 ? 's' : ''} imported across ${totalGroups} group${totalGroups !== 1 ? 's' : ''}`);

      // Reset input so the same folder can be picked again later
      importInput.value = '';
    });
  }
}

// Parse all files in the imported folder into a 3-level hierarchy:
// { groupName: { projectName: [{ name, data }] } }
// Connection-only files (no workflow steps) are filtered out.
async function parseReltioRecipesFiles(files) {
  const groups = {};
  for (const file of files) {
    if (!file.name.endsWith('.json')) continue;
    const relPath = file.webkitRelativePath || file.name;
    const parts = relPath.split(/\\|\//);
    // parts may be: [rootFolder, ...subfolders..., recipeFile.json]
    // We want the last two meaningful path segments as project + group.
    // Filter out the root folder (index 0) and the filename (last).
    const segments = parts.slice(1, -1); // drop root folder name and filename
    const recipeName  = file.name.replace(/\.json$/, '');
    // Use deepest folder as project, its parent as group (or same if only one folder)
    const projectName = segments.length >= 1 ? segments[segments.length - 1] : 'Default';
    const groupName   = segments.length >= 2 ? segments[segments.length - 2] : projectName;

    const content = await file.text();
    let json;
    try { json = JSON.parse(content); } catch (parseErr) { console.warn('[recipes] Skipped invalid JSON:', file.name, parseErr.message); continue; }

    // Filter out Workato connection definitions (no runnable workflow steps)
    if (_isConnectionRecipe(json)) continue;

    if (!groups[groupName]) groups[groupName] = {};
    if (!groups[groupName][projectName]) groups[groupName][projectName] = [];
    groups[groupName][projectName].push({
      name:   recipeName,
      data:   json,
      // Workato uses `running: true` for active recipes; treat absent field as active
      active: json.running !== false,
    });
  }
  // Remove empty groups/projects
  Object.keys(groups).forEach(g => {
    Object.keys(groups[g]).forEach(p => { if (!groups[g][p].length) delete groups[g][p]; });
    if (!Object.keys(groups[g]).length) delete groups[g];
  });
  return groups;
}

// Returns true if the JSON is a Workato connection definition,  not a runnable recipe
function _isConnectionRecipe(json) {
  if (!json || typeof json !== 'object') return true;
  // Has workflow structure → keep
  if (json.code || json.steps || json.block || json.actions) return false;
  // Explicit connection markers → filter out
  if (json.connection_type || json.base_uri || json.authorization_type) return true;
  // No interesting keys at all → filter out
  const keys = Object.keys(json);
  const WORKFLOW_KEYS = new Set(['code','steps','block','actions','version_no','recipe_id','name','description','trigger','triggers']);
  return !keys.some(k => WORKFLOW_KEYS.has(k));
}

// Render 3-level collapsible group/project/recipe tree and wire diagram
function renderProjectsAndRecipes(groups, container, diagramContainer) {
  container.innerHTML = '';

  // Support old flat format { project: [recipes] } gracefully
  function _isThreeLevel(data) {
    const first = Object.values(data || {})[0];
    return first && !Array.isArray(first) && typeof first === 'object';
  }
  if (!_isThreeLevel(groups)) {
    const promoted = {};
    Object.entries(groups).forEach(([proj, recipes]) => { promoted[proj] = { [proj]: recipes }; });
    groups = promoted;
  }

  const groupNames = Object.keys(groups);
  if (!groupNames.length) {
    container.innerHTML = '<div style="color:var(--muted);padding:2rem;">No valid recipe projects found in folder.</div>';
    return;
  }

  function makeToggle(header, body, expanded) {
    const arrow = header.querySelector('.dropdown-arrow');
    header.setAttribute('aria-expanded', String(expanded));
    body.style.display = expanded ? 'block' : 'none';
    if (arrow) arrow.innerHTML = expanded ? '&#9660;' : '&#9654;';
    header.onclick = () => {
      const now = header.getAttribute('aria-expanded') === 'true';
      header.setAttribute('aria-expanded', String(!now));
      body.style.display = now ? 'none' : 'block';
      if (arrow) arrow.innerHTML = now ? '&#9654;' : '&#9660;';
    };
  }

  groupNames.forEach(groupName => {
    const projectMap = groups[groupName];
    const projectNames = Object.keys(projectMap);
    const totalRecipes = projectNames.reduce((t, p) => t + (projectMap[p] || []).length, 0);

    // ── Group level ──
    const groupDiv = document.createElement('div');
    groupDiv.className = 'rc-group-block';

    const groupHeader = document.createElement('button');
    groupHeader.className = 'rc-group-header';
    groupHeader.innerHTML = `<span class="rc-group-label" title="${escapeHtml(groupName)}">${escapeHtml(groupName)}</span><span class="rc-group-count">${totalRecipes}</span><span class="dropdown-arrow">&#9654;</span>`;

    const groupBody = document.createElement('div');
    groupBody.className = 'rc-group-body';

    // Auto-expand if only one group
    makeToggle(groupHeader, groupBody, groupNames.length === 1);

    groupDiv.appendChild(groupHeader);
    groupDiv.appendChild(groupBody);
    container.appendChild(groupDiv);

    // ── Project level ──
    projectNames.forEach(projectName => {
      const recipes = projectMap[projectName] || [];
      if (!recipes.length) return;

      const singleLevel = groupName === projectName;
      let recipeParent = groupBody;

      if (!singleLevel) {
        const projDiv = document.createElement('div');
        projDiv.className = 'project-block';

        const projHeader = document.createElement('button');
        projHeader.className = 'project-header';
        projHeader.innerHTML = `<span class="rc-proj-label" title="${escapeHtml(projectName)}">${escapeHtml(projectName)}</span><span class="rc-group-count">${recipes.length}</span><span class="dropdown-arrow">&#9654;</span>`;

        const projBody = document.createElement('div');
        projBody.className = 'recipe-list';

        makeToggle(projHeader, projBody, false);

        projDiv.appendChild(projHeader);
        projDiv.appendChild(projBody);
        groupBody.appendChild(projDiv);
        recipeParent = projBody;
      }

      // ── Recipe level ──
      recipes.forEach(recipe => {
        const btn = document.createElement('button');
        btn.className = 'recipe-list-btn';
        btn.textContent = recipe.name;
        btn.title = recipe.name;
        btn.onclick = () => {
          renderRecipeDiagram(recipe.data, diagramContainer, recipe.name, projectName);
          container.querySelectorAll('.recipe-list-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        };
        recipeParent.appendChild(btn);
      });
    });
  });
}

// Escape HTML for safe rendering
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Return an icon/badge HTML string for a step based on provider and name
function getStepIcon(step) {
  const provider = (step.provider || '').toLowerCase();
  const name = (step.name || '').toLowerCase();
  const title = (step.title || step.label || '').toLowerCase();
  if (provider === 'reltio') {
    return `<span class="rc-badge-reltio">RELTIO</span>`;
  }
  if (name.includes('repeat') || name.includes('for_each') || name.includes('foreach') || title.includes('for each')) {
    return `<span class="rc-step-icon rc-icon-repeat">&#x21BA;</span>`;
  }
  if (name.includes('log') || title.includes('log message')) {
    return `<span class="rc-step-icon rc-icon-log"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="12" height="14" rx="2" stroke="#14b8a6" stroke-width="1.5"/><line x1="5" y1="5" x2="11" y2="5" stroke="#14b8a6" stroke-width="1"/><line x1="5" y1="8" x2="11" y2="8" stroke="#14b8a6" stroke-width="1"/><line x1="5" y1="11" x2="9" y2="11" stroke="#14b8a6" stroke-width="1"/></svg></span>`;
  }
  if (name.includes('insert') || name.includes('list') || title.includes('insert rows')) {
    return `<span class="rc-step-icon rc-icon-list"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="6" height="6" rx="1" stroke="#38bdf8" stroke-width="1.5"/><rect x="9" y="1" width="6" height="6" rx="1" stroke="#38bdf8" stroke-width="1.5"/><rect x="1" y="9" width="6" height="6" rx="1" stroke="#38bdf8" stroke-width="1.5"/><rect x="9" y="9" width="6" height="6" rx="1" stroke="#38bdf8" stroke-width="1.5"/></svg></span>`;
  }
  if (name.includes('trigger') || name === 'timer' || name === 'scheduler') {
    return `<span class="rc-step-icon rc-icon-trigger">&#9889;</span>`;
  }
  if (name.includes('search') || name.includes('query') || name.includes('get')) {
    return `<span class="rc-step-icon rc-icon-search"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><circle cx="6" cy="6" r="4.5" stroke="#a78bfa" stroke-width="1.5"/><line x1="9.5" y1="9.5" x2="13.5" y2="13.5" stroke="#a78bfa" stroke-width="1.5" stroke-linecap="round"/></svg></span>`;
  }
  if (name.includes('update') || name.includes('upsert') || name.includes('create') || name.includes('write')) {
    return `<span class="rc-step-icon rc-icon-update"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M10 2L13 5L5 13H2V10L10 2Z" stroke="#fbbf24" stroke-width="1.5" stroke-linejoin="round"/></svg></span>`;
  }
  if (name.includes('condition') || name.includes('if')) {
    return `<span class="rc-step-icon rc-icon-condition"><svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M7.5 2L13 13H2L7.5 2Z" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/></svg></span>`;
  }
  return `<span class="rc-step-icon rc-icon-default"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="#64748b" stroke-width="1.5"/></svg></span>`;
}

// Highlight known keywords and provider references within a step label
function highlightStepLabel(raw) {
  return escapeHtml(raw)
    .replace(/\b(FOR EACH|REPEAT|BATCH|STOP)\b/g, '<span class="rc-kw">$1</span>')
    .replace(/\b(in Reltio|in Workato|in Collection|in Snowflake|in Salesforce|to Job report and Workato Logs)\b/g, '<span class="rc-provider-ref">$1</span>')
    .replace(/\b(Step \d+)\b/gi, '<span class="rc-step-ref">$1</span>');
}

// Build fallback steps from a simple source/transform/target recipe
function buildSimpleFlowSteps(recipe) {
  const steps = [];
  let n = 1;
  steps.push({ number: n++, name: 'trigger', title: 'Recipe Trigger', provider: 'workato' });
  (recipe.sources || []).forEach(s => steps.push({ number: n++, name: 'search', title: s.label || s.name || 'Source', provider: 'reltio' }));
  (recipe.transforms || []).forEach(t => steps.push({ number: n++, name: 'transform', title: t.label || t.name || 'Transform', provider: '' }));
  (recipe.targets || []).forEach(t => steps.push({ number: n++, name: 'update', title: t.label || t.name || 'Target', provider: 'reltio' }));
  return steps;
}

// Recursively build step cards (supports nested block/actions/steps)
function buildStepCards(steps, container, isNested) {
  if (!steps || !steps.length) return;
  steps.forEach((step, idx) => {
    const stepNum = step.number != null ? step.number : (idx + 1);
    const rawLabel = step.title || step.label || step.name || `Step ${stepNum}`;
    const keyword = step.keyword || '';
    const iconHtml = getStepIcon(step);
    const nameLower = (step.name || '').toLowerCase();
    const titleLower = (step.title || step.label || '').toLowerCase();
    const isLoopStep = nameLower.includes('repeat') || nameLower.includes('for_each') ||
                       nameLower.includes('foreach') || titleLower.includes('for each');
    const children = step.block || step.actions || step.steps || step.children || null;

    if (idx > 0 || isNested) {
      const conn = document.createElement('div');
      conn.className = 'rc-connector';
      container.appendChild(conn);
    }

    const card = document.createElement('div');
    card.className = 'rc-step-card' + (isNested ? ' rc-step-nested' : '') + (isLoopStep ? ' rc-step-loop-header' : '');
    card.title = rawLabel;  // native tooltip shows full text without layout shift
    card.innerHTML = `
      <div class="rc-step-num">${stepNum}</div>
      <div class="rc-icon-area">${iconHtml}</div>
      <div class="rc-step-desc">
        <span class="rc-step-label">${highlightStepLabel(rawLabel)}</span>
        ${keyword ? `<span class="rc-kw-badge">${escapeHtml(keyword)}</span>` : ''}
      </div>
    `;
    // Click opens step detail panel
    card.addEventListener('click', () => showRecipeStepDetail(step, card));
    container.appendChild(card);

    if (children && children.length) {
      const loopWrap = document.createElement('div');
      loopWrap.className = isLoopStep ? 'rc-loop-block' : 'rc-nested-block';
      buildStepCards(children, loopWrap, true);
      container.appendChild(loopWrap);
    }
  });
}

// Render a key/value row for the step detail panel
function rsdRow(key, val) {
  if (val === undefined || val === null || val === '') return '';
  const display = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
  const isLong = display.length > 80 || display.includes('\n');
  const isCode = typeof val === 'object' || /^[{\["']/.test(display);
  const cls = isLong ? 'rsd-val rsd-val-long' : isCode ? 'rsd-val rsd-val-code' : 'rsd-val';
  return `<div class="rsd-row"><span class="rsd-key">${escapeHtml(key)}</span><span class="${cls}">${escapeHtml(display)}</span></div>`;
}

// Render all enumerable leaf properties of an object as rows, skipping structural keys
function rsdObjectRows(obj, skipKeys) {
  const skip = new Set((skipKeys || []).concat(['block','actions','steps','children','number','uuid']));
  return Object.entries(obj || {})
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== '')
    .map(([k, v]) => rsdRow(k, v))
    .join('');
}

// Build the detail HTML for a step
function buildStepDetailHtml(step) {
  const name  = step.name  || '';
  const provider = step.provider || '';
  const title = step.title || step.label || step.name || 'Step';
  const nl    = name.toLowerCase();

  let html = '';

  // ── Identity ────────────────────────────────────────────────────────────────
  html += '<div class="rsd-section">';
  html += '<div class="rsd-section-title">Step Info</div>';
  html += rsdRow('Name', name);
  html += rsdRow('Provider', provider);
  html += rsdRow('Title', title);
  if (step.comment)     html += rsdRow('Comment', step.comment);
  if (step.description) html += rsdRow('Description', step.description);
  if (step.as)          html += rsdRow('Output as', step.as);
  if (step.keyword)     html += rsdRow('Keyword', step.keyword);
  html += '</div>';

  // ── Input configuration ─────────────────────────────────────────────────────
  if (step.input && typeof step.input === 'object' && Object.keys(step.input).length) {
    // Derive a contextual section heading
    let sectionTitle = 'Configuration';
    if (nl.includes('csv') || nl.includes('parse'))         sectionTitle = 'CSV Parser Settings';
    else if (nl.includes('create_list') || nl.includes('insert') || nl.includes('list')) sectionTitle = 'List Configuration';
    else if (nl.includes('search') || nl.includes('query')) sectionTitle = 'Search / Query Parameters';
    else if (nl.includes('update') || nl.includes('upsert') || nl.includes('batch'))     sectionTitle = 'Update Parameters';
    else if (nl.includes('log'))                            sectionTitle = 'Log Configuration';
    else if (nl.includes('trigger') || nl.includes('timer') || nl.includes('scheduler')) sectionTitle = 'Trigger Settings';
    else if (provider === 'reltio')                         sectionTitle = 'Reltio Configuration';

    html += '<div class="rsd-section">';
    html += `<div class="rsd-section-title">${escapeHtml(sectionTitle)}</div>`;
    html += rsdObjectRows(step.input, []);
    html += '</div>';
  }

  // ── Output schema ────────────────────────────────────────────────────────────
  if (step.output && typeof step.output === 'object' && Object.keys(step.output).length) {
    html += '<div class="rsd-section">';
    html += '<div class="rsd-section-title">Output Schema</div>';
    html += rsdObjectRows(step.output, []);
    html += '</div>';
  }

  // ── Extra top-level fields (catch-all for any remaining properties) ───────────
  const knownKeys = new Set(['name','provider','title','label','comment','description','as','keyword',
    'input','output','block','actions','steps','children','number','uuid','type']);
  const extra = Object.entries(step).filter(([k]) => !knownKeys.has(k) && step[k] !== null && step[k] !== undefined);
  if (extra.length) {
    html += '<div class="rsd-section">';
    html += '<div class="rsd-section-title">Additional Properties</div>';
    extra.forEach(([k, v]) => { html += rsdRow(k, v); });
    html += '</div>';
  }

  if (html.replace(/<[^>]+>/g, '').trim() === '') {
    html = '<div class="rsd-empty">No additional details available for this step.</div>';
  }

  return html;
}

// Show the step detail panel with info about the clicked step
function showRecipeStepDetail(step, activeCard) {
  const panel  = document.getElementById('recipeStepDetailPanel');
  const inner  = document.getElementById('recipeStepDetailInner');
  const layout = document.getElementById('recipeFlexLayout');
  if (!panel || !inner) return;

  // Highlight only the active card
  document.querySelectorAll('.rc-step-card').forEach(c => c.classList.remove('rc-active'));
  if (activeCard) activeCard.classList.add('rc-active');

  const title = step.title || step.label || step.name || 'Step Details';

  try {
    inner.innerHTML =
      `<div class="rsd-header">
         <h3>${escapeHtml(title)}</h3>
         <button class="rsd-close-btn" title="Close details" onclick="closeRecipeStepDetail()">&times;</button>
       </div>` +
      buildStepDetailHtml(step);
  } catch (err) {
    inner.innerHTML = `<div class="rsd-header"><h3>${escapeHtml(title)}</h3><button class="rsd-close-btn" onclick="closeRecipeStepDetail()">&times;</button></div><div class="rsd-empty">Error rendering detail: ${escapeHtml(String(err.message))}</div>`;
  }

  panel.style.display = 'flex';
  if (layout) layout.classList.add('has-detail');
}
window.showRecipeStepDetail = showRecipeStepDetail;

function closeRecipeStepDetail() {
  const panel  = document.getElementById('recipeStepDetailPanel');
  const layout = document.getElementById('recipeFlexLayout');
  if (panel)  panel.style.display = 'none';
  if (layout) layout.classList.remove('has-detail');
  document.querySelectorAll('.rc-step-card').forEach(c => c.classList.remove('rc-active'));
}
window.closeRecipeStepDetail = closeRecipeStepDetail;

// Render a visual card-based flow diagram for a recipe
function renderRecipeDiagram(recipe, diagramContainer, recipeName, projectName) {
  diagramContainer.innerHTML = '';

  const box = document.createElement('div');
  box.id = 'recipeDiagramBox';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close';
  closeBtn.onclick = () => { diagramContainer.innerHTML = ''; };
  box.appendChild(closeBtn);

  // Title
  const titleEl = document.createElement('div');
  titleEl.className = 'recipe-diagram-title';
  titleEl.innerHTML = `<span class="rdTitle-project">${escapeHtml(projectName)}</span><span style="color:#64748b;margin:0 0.4em;">/</span><span class="rdTitle-name">${escapeHtml(recipeName)}</span>`;
  box.appendChild(titleEl);

  // Resolve root steps from any recognizable recipe format
  let rootSteps = [];
  if (recipe && recipe.code && typeof recipe.code === 'object') {
    // Workato format: root code object is the trigger; its block contains child steps
    rootSteps = [recipe.code];
  } else if (recipe && Array.isArray(recipe.steps)) {
    rootSteps = recipe.steps;
  } else if (recipe && Array.isArray(recipe.block)) {
    rootSteps = recipe.block;
  } else if (recipe && Array.isArray(recipe.actions)) {
    rootSteps = recipe.actions;
  } else if (recipe && (recipe.sources || recipe.transforms || recipe.targets)) {
    rootSteps = buildSimpleFlowSteps(recipe);
  } else if (recipe && typeof recipe === 'object' && Object.keys(recipe).length) {
    rootSteps = [recipe];
  }

  const flow = document.createElement('div');
  flow.className = 'recipe-card-flow';

  if (!rootSteps.length) {
    flow.innerHTML = '<div style="color:#94a3b8;padding:1.5rem 0;">No steps found in this recipe. Expected a Workato recipe JSON with a <code>code</code> property or an array of <code>steps</code>.</div>';
  } else {
    buildStepCards(rootSteps, flow, false);
  }

  box.appendChild(flow);
  diagramContainer.appendChild(box);
}

function showStrategyDetail(strategyIndex) {
  const strategy = configParser.survivorshipStrategies[strategyIndex];
  if (!strategy) return;
  
  const detail = document.getElementById('recipeDetail');
  detail.innerHTML = `
    <div class="detail-header">
      <h2>${strategy.label}</h2>
    </div>
    <div class="detail-section">
      <h3>⚙️ Survivorship Strategy</h3>
      <div class="detail-row">
        <div class="detail-label">Name</div>
        <div class="detail-value">${strategy.label}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">URI</div>
        <div class="detail-value" style="font-size: 0.9rem; word-break: break-all;">${strategy.uri}</div>
      </div>
      ${strategy.winnerSourceType ? `
        <div class="detail-row">
          <div class="detail-label">Winner Source Type</div>
          <div class="detail-value">${strategy.winnerSourceType.split('/').pop()}</div>
        </div>
      ` : ''}
      ${strategy.winnerSourceAttributes && strategy.winnerSourceAttributes.length > 0 ? `
        <div class="detail-row">
          <div class="detail-label">Winner Source Attributes</div>
          <div class="detail-value">${strategy.winnerSourceAttributes.join(', ')}</div>
        </div>
      ` : ''}
    </div>
  `;
}

// ── Integration Registry ──────────────────────────────────────────────────
let _regDirFilter  = '';
let _regSearchTerm = '';

function renderRegistry() {
  const connections = getAvailableSystems();
  _renderRegistryMetrics(connections);
  _renderRegistryCards(connections, _regDirFilter, _regSearchTerm);
  _wireRegistryFilters();
}

function _renderRegistryMetrics(connections) {
  const el = document.getElementById('registryMetricsBar');
  if (!el) return;
  const withRecipes = connections.filter(c => c.hasRecipes).length;
  const inC  = connections.filter(c => c.direction === 'Inbound'  || c.direction === 'Bidirectional').length;
  const outC = connections.filter(c => c.direction === 'Outbound' || c.direction === 'Bidirectional').length;
  const biC  = connections.filter(c => c.direction === 'Bidirectional').length;
  const totalR = connections.reduce((t, c) => t + (c.totalRecipes || 0), 0);
  const totalSteps = connections.reduce((t, c) => t + (c.steps ? c.steps.length : 0), 0);
  const unmatched = getUnmatchedConnections().length;
  el.innerHTML = [
    [connections.length, 'Source Systems'],
    [withRecipes, 'With Recipes'],
    [inC,   'Inbound'],
    [outC,  'Outbound'],
    [biC,   'Bidirectional'],
    [totalR, 'Recipes'],
    [totalSteps, 'Steps'],
    ...(unmatched ? [[unmatched, 'Unmatched']] : []),
  ].map(([n, lbl]) =>
    `<div class="reg-metric"><span class="reg-metric-num">${n}</span><span class="reg-metric-lbl">${lbl}</span></div>`
  ).join('');
}

function _renderRegistryCards(connections, dirFilter, searchTerm) {
  const container = document.getElementById('registrySystemCards');
  if (!container) return;
  let list = connections;
  if (dirFilter) list = list.filter(c => c.direction === dirFilter || c.direction === 'Bidirectional');
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    list = list.filter(c => c.label.toLowerCase().includes(t));
  }

  const unmatched = dirFilter || searchTerm ? [] : getUnmatchedConnections().filter(c =>
    !searchTerm || c.label.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!list.length && !unmatched.length) {
    container.innerHTML = `<div class="reg-empty">${connections.length ? 'No systems match the current filter.' : 'Load a Reltio configuration to see source systems.'}</div>`;
    return;
  }

  function rowHtml(conn, isUnmatched) {
    const cl = systemColor(conn.label);
    const dirClass = conn.direction === 'Inbound' ? 'inbound' : conn.direction === 'Outbound' ? 'outbound' : 'bidi';
    const dirLabel = conn.direction === 'Inbound' ? '↓ Inbound' : conn.direction === 'Outbound' ? '↑ Outbound' : '⇄ Bidirectional';
    const allR = [...new Set([...(conn.inboundRecipes || []), ...(conn.outboundRecipes || [])])];
    const abbr = conn.abbreviation ? `<span class="reg-sys-abbr" style="color:${cl.border};">${escapeHtml(conn.abbreviation)}</span>` : '';
    const warningBadge = isUnmatched ? `<span style="font-size:0.7em;color:#f59e0b;margin-left:0.3rem;" title="Not in Reltio config">⚠</span>` : '';
    const noRecipeNote = !conn.hasRecipes && !isUnmatched ? `<span style="font-size:0.7em;color:#475569;margin-left:0.5rem;font-style:italic;">config only</span>` : '';
    return `<tr class="reg-list-row${isUnmatched ? ' reg-card-unmatched' : ''}" data-system="${escapeHtml(conn.label)}"
        style="border-left:3px solid ${cl.border}; cursor:pointer;"
        onclick="showRegistryDetail('${escapeHtml(conn.label).replace(/'/g, "\\'")}')"
      >
      <td style="padding:0.55rem 0.75rem;">
        <span class="reg-dot" style="background:${cl.border};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:0.4rem;vertical-align:middle;"></span>
        ${abbr}
        <span class="reg-sys-name" style="color:#e0e7ff;font-weight:600;font-size:0.9rem;">${escapeHtml(conn.label)}</span>
        ${warningBadge}${noRecipeNote}
      </td>
      <td style="padding:0.55rem 0.75rem;"><span class="reg-dir-badge ${dirClass}">${dirLabel}</span></td>
      <td style="padding:0.55rem 0.75rem;text-align:center;color:#64748b;font-size:0.82em;">${conn.totalRecipes || 0}</td>
      <td style="padding:0.55rem 0.75rem;text-align:center;color:#64748b;font-size:0.82em;">${conn.steps ? conn.steps.length : 0}</td>
      <td style="padding:0.55rem 0.75rem;text-align:center;color:#64748b;font-size:0.82em;">${conn.fieldMappings ? conn.fieldMappings.length : 0}</td>
      <td style="padding:0.55rem 0.75rem;max-width:220px;">
        ${allR.slice(0, 3).map(r => `<span class="reg-recipe-chip">${escapeHtml(r)}</span>`).join('')}
        ${allR.length > 3 ? `<span class="reg-more">+${allR.length - 3}</span>` : ''}
      </td>
    </tr>`;
  }

  let rowsHtml = list.map(c => rowHtml(c, false)).join('');
  if (unmatched.length) {
    rowsHtml += `<tr><td colspan="6" style="padding:0.5rem 0.75rem;font-size:0.75em;color:#64748b;background:rgba(100,116,139,0.05);border-top:1px solid rgba(148,163,184,0.15);">
      ⚠ Other / Unmatched — found in recipes but not in Reltio config sources
    </td></tr>` + unmatched.map(c => rowHtml(c, true)).join('');
  }

  container.innerHTML = `<table class="reg-list-table" style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:rgba(15,23,42,0.8);position:sticky;top:0;z-index:1;">
        <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75em;font-weight:600;text-transform:uppercase;">System</th>
        <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75em;font-weight:600;text-transform:uppercase;">Direction</th>
        <th style="padding:0.5rem 0.75rem;text-align:center;color:#64748b;font-size:0.75em;font-weight:600;text-transform:uppercase;">Recipes</th>
        <th style="padding:0.5rem 0.75rem;text-align:center;color:#64748b;font-size:0.75em;font-weight:600;text-transform:uppercase;">Steps</th>
        <th style="padding:0.5rem 0.75rem;text-align:center;color:#64748b;font-size:0.75em;font-weight:600;text-transform:uppercase;">Fields</th>
        <th style="padding:0.5rem 0.75rem;text-align:left;color:#64748b;font-size:0.75em;font-weight:600;text-transform:uppercase;">Recipes</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

function _wireRegistryFilters() {
  document.querySelectorAll('.reg-dir-btn').forEach(btn => {
    if (btn._regBound) return;
    btn._regBound = true;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.reg-dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _regDirFilter = btn.dataset.dir;
      _renderRegistryCards(getAvailableSystems(), _regDirFilter, _regSearchTerm);
    });
  });
  const si = document.getElementById('registrySearch');
  if (si && !si._regBound) {
    si._regBound = true;
    si.addEventListener('input', e => {
      _regSearchTerm = e.target.value;
      _renderRegistryCards(getAvailableSystems(), _regDirFilter, _regSearchTerm);
    });
  }
}

function showRegistryDetail(systemLabel) {
  const panel   = document.getElementById('registryDetailPanel');
  const conn    = getAvailableSystems().find(c => c.label === systemLabel);
  if (!panel) return;

  // Toggle off if already showing same system
  if (panel.style.display !== 'none' && panel.dataset.system === systemLabel) {
    panel.style.display = 'none';
    document.querySelectorAll('.reg-list-row,.reg-system-card').forEach(c => c.classList.remove('reg-card-active'));
    return;
  }
  document.querySelectorAll('.reg-list-row,.reg-system-card').forEach(c =>
    c.classList.toggle('reg-card-active', c.dataset.system === systemLabel)
  );

  const cl = systemColor(systemLabel);
  const closeBtn = `<button class="rsd-close-btn" onclick="document.getElementById('registryDetailPanel').style.display='none';document.querySelectorAll('.reg-list-row,.reg-system-card').forEach(c=>c.classList.remove('reg-card-active'));">&times;</button>`;

  // Also check unmatched connections pool
  const unmatchedConn = !conn ? getUnmatchedConnections().find(c => c.label === systemLabel) : null;
  const resolvedConn = conn || unmatchedConn;

  function _buildStepsHtml(steps) {
    const stepsByRecipe = {};
    (steps || []).forEach(s => {
      const k = `${s.project} / ${s.recipe}`;
      (stepsByRecipe[k] = stepsByRecipe[k] || []).push(s);
    });
    return Object.entries(stepsByRecipe).map(([rName, ss]) => {
      const stepRows = ss.map(s => {
        const dirIcon = s.direction === 'outbound' ? '\u2191' : '\u2193';
        const inputRows = Object.entries(s.input || {}).slice(0, 8).map(([k, v]) =>
          `<div class="rsd-row"><span class="rsd-key">${escapeHtml(k)}</span><span class="rsd-val rsd-val-code">${escapeHtml(String(v ?? '').substring(0, 90))}</span></div>`
        ).join('');
        const moreFields = Object.keys(s.input || {}).length > 8
          ? `<div style="color:#475569;font-size:0.73rem;padding:0.15rem 0;">+${Object.keys(s.input).length - 8} more fields</div>` : '';
        return `<div class="reg-step-item">
          <span class="reg-step-dir-badge ${s.direction}">${dirIcon} ${s.direction}</span>
          <span class="reg-step-title">${escapeHtml(s.title)}</span>
          ${inputRows ? `<div class="reg-step-inputs">${inputRows}${moreFields}</div>` : ''}
        </div>`;
      }).join('');
      return `<div class="reg-recipe-group"><div class="reg-recipe-group-name">${escapeHtml(rName)}</div>${stepRows}</div>`;
    }).join('');
  }

  // Config source info
  const src = configParser?.sources.find(s => s.label === systemLabel);
  const configSection = src
    ? `<div class="rsd-section-title">Reltio Config Source</div>
       ${rsdRow('Label', src.label)}${rsdRow('Abbreviation', src.abbreviation)}${rsdRow('URI', src.uri)}`
    : `<div class="reg-config-note reg-unmatched-note" style="margin-bottom:0.5rem;">\u26a0\ufe0f Not found in Reltio config sources</div>`;

  const allR = resolvedConn ? [...new Set([...(resolvedConn.inboundRecipes || []), ...(resolvedConn.outboundRecipes || [])])] : [];

  panel.dataset.system = systemLabel;
  panel.style.display = 'flex';
  panel.innerHTML = `
    <div class="reg-detail-header" style="border-left:3px solid ${cl.border};">
      <h3 style="color:${cl.border};">${escapeHtml(systemLabel)}</h3>${closeBtn}
    </div>
    <div class="reg-detail-body">
      ${configSection}
      <div style="height:0.6rem;"></div>
      ${resolvedConn ? `
        ${rsdRow('Direction', resolvedConn.direction)}
        ${rsdRow('Recipes', String(resolvedConn.totalRecipes || 0))}
        ${rsdRow('Steps', String(resolvedConn.steps ? resolvedConn.steps.length : 0))}
        ${rsdRow('Field mappings', String(resolvedConn.fieldMappings ? resolvedConn.fieldMappings.length : 0))}
        <div style="height:0.6rem;"></div>
        <div class="rsd-section-title">Recipes</div>
        ${_buildRecipeListHtml(resolvedConn)}
      ` : '<div class="reg-config-note">Import Reltio recipes to see live field mappings and recipe details.</div>'}
    </div>`;
}
window.showRegistryDetail = showRegistryDetail;

// ============================================================
// LINEAGE EXPLORER — Attribute-level source → MDM → export map
// Uses recipe-derived connections; falls back to Reltio config
// ============================================================

function linSurvivorshipRule(attr, entity) {
  const label  = (attr.label || '').toLowerCase();
  const groups = entity.survivorshipGroups || [];
  const match  = groups.find(g => g.label && g.label.toLowerCase().includes(label.split(' ')[0]));
  if (match) return match.label.replace(/ Survivorship$/, '');
  if (attr.type === 'date')   return 'Most Recent';
  if (attr.type === 'number') return 'Source Priority';
  if (attr.type === 'enum')   return 'Frequency';
  if (/\bid\b|code/.test(label)) return 'Source Priority';
  if (/address|city|postal|zip/.test(label)) return 'Cleanser Wins';
  if (/email|phone/.test(label)) return 'Frequency';
  return 'Source Priority';
}

// State
let lineageSelectedSources = new Set();
let lineageSelectedEntity  = '';
let lineageSearchTerm      = '';
let lineageShowUnmapped    = false; // when DL mappings loaded, unmapped attrs hidden by default

function renderLineage() {
  const systems = getAvailableSystems();
  const hasConfig = !!configParser;

  if (hasConfig && !lineageSelectedEntity && configParser.entities.length) {
    lineageSelectedEntity = configParser.entities[0].label;
  }

  renderLineageSourcePills(systems);
  if (hasConfig) {
    renderLineageEntityPills();
    renderLineageAttrMap(systems);
    renderLineageSideStats();
  } else {
    const rows = document.getElementById('lineageAttrRows');
    if (rows) rows.innerHTML = '<div class="lin-empty">Load a Reltio configuration (Load Config / Load Sample Config) to see attribute-level mappings.</div>';
  }

  const searchEl = document.getElementById('lineageSearch');
  if (searchEl && !searchEl._linBound) {
    searchEl._linBound = true;
    searchEl.addEventListener('input', e => { lineageSearchTerm = e.target.value; renderLineageAttrMap(getAvailableSystems()); });
  }
}

function renderLineageSourcePills(systems) {
  const container = document.getElementById('lineageSourcePills');
  if (!container) return;
  systems = systems || getAvailableSystems();

  if (!systems.length) {
    container.innerHTML = '<div class="lin-no-sources" style="padding:0.4rem 0;">No systems found. Import recipes or load a config.</div>';
    return;
  }

  container.innerHTML = systems.map(sys => {
    const cl     = systemColor(sys.label);
    const abbr   = sys.abbreviation || sys.label.substring(0, 6);
    const active = lineageSelectedSources.has(sys.label);
    const dirIcon = sys.direction === 'Outbound' ? '\u2191' : sys.direction === 'Bidirectional' ? '\u21c4' : '\u2193';
    return `<button class="lin-source-pill${active ? ' active' : ''}" data-syskey="${escapeHtml(sys.label)}"
        style="border-color:${cl.border};${active ? `background:${cl.bg};color:${cl.text};` : ''}">
        <span class="lin-pill-dot" style="background:${cl.border};"></span>
        <span class="lin-pill-abbr" style="${active ? `color:${cl.text};` : ''}">${escapeHtml(abbr)}</span>
        <span class="lin-pill-name">${escapeHtml(sys.label)}</span>
        <span class="lin-pill-dir">${dirIcon}</span>
      </button>`;
  }).join('') + `<button class="lin-clear-btn" id="linClearSrc">\u2715 Clear</button>`;

  container.querySelectorAll('.lin-source-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.syskey;
      lineageSelectedSources.has(key) ? lineageSelectedSources.delete(key) : lineageSelectedSources.add(key);
      renderLineage();
    });
  });
  const cb = document.getElementById('linClearSrc');
  if (cb) cb.addEventListener('click', () => { lineageSelectedSources.clear(); renderLineage(); });
}

function renderLineageEntityPills() {
  const container = document.getElementById('lineageEntityPills');
  if (!container) return;

  container.innerHTML = configParser.entities.map(entity => {
    const active = lineageSelectedEntity === entity.label;
    const dlEntry = _dataloaderMappings ? (_dataloaderMappings[entity.uri] || null) : null;
    const countLabel = dlEntry !== null
      ? `<span class="lin-attr-count" title="${dlEntry.length} mapped / ${entity.attributeCount} total">${dlEntry.length}<span style="opacity:0.5;font-size:0.85em;">/${entity.attributeCount}</span></span>`
      : `<span class="lin-attr-count">${entity.attributeCount}</span>`;
    return `<button class="lin-entity-pill${active ? ' active' : ''}" data-label="${entity.label}"
        style="border-left-color:${entity.typeColor || '#38bdf8'};">
        ${entity.label}
        ${countLabel}
      </button>`;
  }).join('');

  container.querySelectorAll('.lin-entity-pill').forEach(btn => {
    btn.addEventListener('click', () => { lineageSelectedEntity = btn.dataset.label; lineageShowUnmapped = false; renderLineage(); });
  });
}

function renderLineageAttrMap(systems) {
  const container = document.getElementById('lineageAttrRows');
  const countEl   = document.getElementById('lineageRowCount');
  if (!container || !configParser) return;
  systems = systems || getAvailableSystems();

  const entity = configParser.entities.find(e => e.label === lineageSelectedEntity);
  if (!entity) { container.innerHTML = '<div class="lin-empty">Select an entity type on the left to view its attribute lineage.</div>'; return; }

  // DL mapping data for this entity
  const dlEntry   = _dataloaderMappings  ? (_dataloaderMappings[entity.uri]  || null) : null;
  const dlSet     = dlEntry ? new Set(dlEntry) : null;
  const dlFMap    = _dataloaderFieldMaps ? (_dataloaderFieldMaps[entity.uri] || {}) : {};
  const hasDL     = dlSet !== null;

  // Filter by selected sources (key is system label)
  const filterActive = lineageSelectedSources.size > 0;
  const activeSys    = filterActive ? systems.filter(s => lineageSelectedSources.has(s.label)) : systems;

  const inboundSys  = activeSys.filter(s => s.direction === 'Inbound'  || s.direction === 'Bidirectional');
  const outboundSys = activeSys.filter(s => s.direction === 'Outbound' || s.direction === 'Bidirectional');

  // Flatten attrs (include nested)
  const allAttrs = [];
  function collect(list, depth) {
    (list || []).forEach(a => { allAttrs.push({ ...a, _depth: depth }); collect(a.attributes, depth + 1); });
  }
  collect(entity.attributes, 0);

  const term = lineageSearchTerm.trim().toLowerCase();
  let rows = term ? allAttrs.filter(a =>
    (a.label || '').toLowerCase().includes(term) || (a.type || '').toLowerCase().includes(term)
  ) : allAttrs;

  // Count unmapped before filtering
  const unmappedCount = hasDL
    ? rows.filter(a => !dlSet.has((a.uri || '').split('/').pop())).length
    : 0;

  // Render toggle bar when DL data is available
  let toggleBar = '';
  if (hasDL && unmappedCount > 0) {
    toggleBar = `<div style="display:flex;align-items:center;gap:0.75rem;padding:0.5rem 0.75rem;margin-bottom:0.5rem;background:rgba(16,185,129,0.05);border-radius:4px;border-left:2px solid #10b981;font-size:0.8em;color:#64748b;">
      <span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:4px;vertical-align:middle;"></span>Mapped from source</span>
      <span style="color:#475569;">|</span>
      <span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#1e293b;border:1px solid #475569;margin-right:4px;vertical-align:middle;"></span>Not in Dataloader mappings (${unmappedCount})</span>
      <button onclick="window._lineageToggleUnmapped()" style="margin-left:auto;font-size:0.8em;padding:0.15rem 0.6rem;border-radius:999px;border:1px solid rgba(148,163,184,0.3);background:${lineageShowUnmapped ? 'rgba(245,158,11,0.1)' : 'transparent'};color:${lineageShowUnmapped ? '#f59e0b' : '#64748b'};cursor:pointer;">${lineageShowUnmapped ? '\u25b2 Hide Unmapped' : '\u25bc Show Unmapped'}</button>
    </div>`;
  } else if (hasDL) {
    toggleBar = `<div style="font-size:0.78em;color:#64748b;padding:0.4rem 0.75rem;margin-bottom:0.5rem;background:rgba(16,185,129,0.05);border-radius:4px;border-left:2px solid #10b981;">All attributes for this entity are mapped via the Dataloader.</div>`;
  }

  // Apply unmapped filter
  if (hasDL && !lineageShowUnmapped) {
    rows = rows.filter(a => dlSet.has((a.uri || '').split('/').pop()));
  }

  if (countEl) countEl.textContent = `${rows.length} attribute${rows.length !== 1 ? 's' : ''}${hasDL && !lineageShowUnmapped ? ` (${unmappedCount} unmapped hidden)` : ''}`;

  if (!rows.length) { container.innerHTML = toggleBar + '<div class="lin-empty">No attributes match the current filter.</div>'; return; }

  function chipHtml(sys, attr) {
    const cl        = systemColor(sys.label);
    const shortName = (attr.uri || '').split('/').pop();
    const abbr      = sys.abbreviation || sys.label.replace(/\s+/g, '').substring(0, 6);
    // Use real DL field name when available, otherwise fall back to heuristic
    const dlField   = dlFMap[shortName];
    const field     = dlField || getSystemFieldName(sys.label, attr.label);
    const tooltip   = dlField ? `Source column: ${field}` : `Derived name: ${field}`;
    const isDLField = !!dlField;
    // RDM value translation for enum attrs
    let rdmHtml = '';
    if (attr.type === 'enum') {
      const rdmTypeName = findRDMTypeForAttr(shortName);
      if (rdmTypeName && _rdmData?.[rdmTypeName]) {
        const rdmEntry = _rdmData[rdmTypeName];
        const sysVals  = rdmEntry.values.filter(v => v.sourceMappings?.[sys.label]);
        if (sysVals.length > 0) {
          const preview = sysVals.slice(0, 3).map(v =>
            `${escapeHtml(v.sourceMappings[sys.label])} → ${escapeHtml(v.reltioValue)}`
          ).join('<br>');
          const more = sysVals.length > 3 ? `<br>+${sysVals.length - 3} more` : '';
          rdmHtml = `<div class="lin-rdm-values" style="margin-top:0.3rem;font-size:0.7em;color:#94a3b8;border-top:1px solid rgba(99,102,241,0.2);padding-top:0.25rem;" title="${rdmTypeName} value translations">${preview}${more}</div>`;
        }
      }
    }
    return `<div class="lin-field-chip" style="border-color:${cl.border};${isDLField ? '' : 'opacity:0.55;border-style:dashed;'}" title="${escapeHtml(tooltip)}">
      <span class="lin-chip-abbr" style="background:${cl.bg};color:${cl.text};">${escapeHtml(abbr)}</span>
      <span class="lin-chip-field">${escapeHtml(field)}</span>
      ${rdmHtml}
    </div>`;
  }

  container.innerHTML = toggleBar + rows.map(attr => {
    const indent    = attr._depth > 0 ? `padding-left:${0.9 + attr._depth * 1.2}rem;` : '';
    const surv      = linSurvivorshipRule(attr, entity);
    const shortName = (attr.uri || '').split('/').pop();
    const isMapped  = hasDL ? dlSet.has(shortName) : true;
    const rowStyle  = isMapped ? '' : 'opacity:0.35;';

    // Only show source chips when the attr is actually mapped (or DL not available)
    const showChips = !hasDL || isMapped;
    const inHtml  = (showChips && inboundSys.length)
      ? inboundSys.map(s => chipHtml(s, attr)).join('')
      : '<div class="lin-no-sources" style="font-size:0.75em;color:#334155;">—</div>';
    const outHtml = (outboundSys.length)
      ? outboundSys.map(s => chipHtml(s, attr)).join('')
      : '<div class="lin-no-sources">—</div>';

    return `<div class="lin-attr-row${attr._depth > 0 ? ' lin-attr-nested' : ''}" style="${rowStyle}">
      <div class="lin-col lin-col-inbound" style="${indent}">${inHtml}</div>
      <div class="lin-arrow lin-arrow-in">→</div>
      <div class="lin-col lin-col-mdm">
        <div class="lin-mdm-label">${escapeHtml(attr.label || '')}${attr.multiValue ? ' <span class="lin-multi-badge">[ ]</span>' : ''}</div>
        <div class="lin-mdm-meta">
          <span class="lin-type-badge">${escapeHtml(attr.type || 'string')}</span>
          <span class="lin-surv-badge">${escapeHtml(surv)}</span>
          ${hasDL && !isMapped ? '<span style="font-size:0.7em;color:#475569;padding:0.1rem 0.35rem;border:1px solid #334155;border-radius:3px;">not loaded</span>' : ''}
          ${(() => { const rn = attr.type === 'enum' ? findRDMTypeForAttr(shortName) : null; return rn && _rdmData?.[rn] ? `<span style="font-size:0.7em;color:#818cf8;padding:0.1rem 0.35rem;border:1px solid rgba(99,102,241,0.35);border-radius:3px;cursor:default;" title="Lookup: ${escapeHtml(rn)}">${_rdmData[rn].values.length} vals</span>` : ''; })()}
        </div>
      </div>
      <div class="lin-arrow lin-arrow-out">→</div>
      <div class="lin-col lin-col-outbound">${outHtml}</div>
    </div>`;
  }).join('');

  // Wire up toggle after render
  window._lineageToggleUnmapped = () => { lineageShowUnmapped = !lineageShowUnmapped; renderLineageAttrMap(getAvailableSystems()); };
}

function renderLineageSideStats() {
  const container = document.getElementById('lineageSideSummary');
  if (!container || !configParser) return;
  const entity  = configParser.entities.find(e => e.label === lineageSelectedEntity);
  const dlEntry = entity && _dataloaderMappings ? (_dataloaderMappings[entity.uri] || null) : null;

  // ── Coverage bar: per-source field contributions ───────────────────────────
  let coverageBarHtml = '';
  if (entity && _recipeReltioMappings && Object.keys(_recipeReltioMappings).length > 0) {
    // Collect per-source field contributions (from recipe mappings)
    const sourceContribs = {};
    Object.entries(_recipeReltioMappings).forEach(([recipeKey, mappings]) => {
      mappings.forEach(m => {
        if (!m.entityTypePath || !m.entityTypePath.includes(entity.label.split(' ').pop())) return;
        // Derive source label from recipe key (first path segment)
        const src = recipeKey.split('/')[0] || recipeKey;
        sourceContribs[src] = (sourceContribs[src] || 0) + (m.pillCount || 1);
      });
    });
    const totalMapped = dlEntry ? dlEntry.length : Object.values(sourceContribs).reduce((s, v) => s + v, 0);
    const totalAttrs  = entity.attributeCount || 1;
    const pct         = Math.min(100, Math.round((totalMapped / totalAttrs) * 100));
    const SEGMENT_COLORS = ['#38bdf8','#818cf8','#34d399','#fbbf24','#f87171','#a78bfa'];
    const entries = Object.entries(sourceContribs);
    const segments = entries.map(([src, cnt], i) => {
      const segPct = Math.max(1, Math.round((cnt / totalAttrs) * 100));
      return `<div class="cov-bar-segment" style="width:${segPct}%;background:${SEGMENT_COLORS[i % SEGMENT_COLORS.length]};" title="${escapeHtml(src)}: ${cnt} fields"></div>`;
    }).join('');

    coverageBarHtml = `
      <div class="lsb-section-title" style="margin-top:0.75rem;">ATTRIBUTE COVERAGE</div>
      <div class="cov-bar-wrap">
        <div class="cov-bar-track">${segments || '<div class="cov-bar-segment" style="width:0%;"></div>'}</div>
        <div class="cov-bar-label">${totalMapped} / ${totalAttrs} attrs (${pct}%)</div>
      </div>
      ${entries.map(([src, cnt], i) =>
        `<div class="lin-stat-row" style="font-size:0.72rem;">
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${SEGMENT_COLORS[i % SEGMENT_COLORS.length]};margin-right:4px;"></span>${escapeHtml(src)}</span>
          <span class="lin-stat-val">${cnt}</span>
        </div>`
      ).join('')}`;
  } else if (entity && dlEntry !== null) {
    const pct = Math.min(100, Math.round((dlEntry.length / (entity.attributeCount || 1)) * 100));
    coverageBarHtml = `
      <div class="lsb-section-title" style="margin-top:0.75rem;">ATTRIBUTE COVERAGE</div>
      <div class="cov-bar-wrap">
        <div class="cov-bar-track"><div class="cov-bar-segment" style="width:${pct}%;background:#10b981;" title="DL Mapped: ${dlEntry.length}"></div></div>
        <div class="cov-bar-label">${dlEntry.length} / ${entity.attributeCount} attrs (${pct}%)</div>
      </div>`;
  }

  container.innerHTML = `
    <div class="lsb-section-title">SUMMARY</div>
    <div class="lin-stat-row"><span>Entity</span><span class="lin-stat-val">${entity ? entity.label : '—'}</span></div>
    <div class="lin-stat-row"><span>Total Attributes</span><span class="lin-stat-val">${entity ? entity.attributeCount : '—'}</span></div>
    ${dlEntry !== null ? `<div class="lin-stat-row"><span style="color:#10b981;">Loaded via DL</span><span class="lin-stat-val" style="color:#10b981;">${dlEntry.length}</span></div>` : ''}
    ${dlEntry !== null ? `<div class="lin-stat-row"><span style="color:#475569;">Not in DL</span><span class="lin-stat-val" style="color:#475569;">${entity.attributeCount - dlEntry.length}</span></div>` : ''}
    <div class="lin-stat-row"><span>Active sources</span><span class="lin-stat-val">${lineageSelectedSources.size || configParser.sources.length}</span></div>
    <div class="lin-stat-row"><span>Relationships</span><span class="lin-stat-val">${entity ? entity.relationshipCount : '—'}</span></div>
    ${_rdmData ? `<div class="lin-stat-row"><span style="color:#818cf8;">RDM lookup types</span><span class="lin-stat-val" style="color:#818cf8;">${Object.keys(_rdmData).length}</span></div>` : ''}
    <div class="lin-stat-row"><span>Survivorship groups</span><span class="lin-stat-val">${entity ? entity.survivorshipGroupCount : '—'}</span></div>
    <div class="lin-stat-row"><span>Match groups</span><span class="lin-stat-val">${entity ? (entity.matchGroupCount || 0) : '—'}</span></div>
    ${coverageBarHtml}
  `;
}

// ========== BUTTON HANDLERS ==========

// Architecture Tab Buttons
const initializeButtons = () => {
  const exportSvgBtn = document.getElementById('exportSvg');
  const reloadConfigBtn = document.getElementById('reloadConfig');
  const modelViewBtn    = document.getElementById('archModelViewBtn');
  const matrixBtn       = document.getElementById('archCoverageMatrixBtn');
  const closeMatrixBtn  = document.getElementById('closeCoverageMatrix');

  if (exportSvgBtn) {
    exportSvgBtn.addEventListener('click', () => {
      showNotification('SVG export coming soon');
    });
  }

  if (reloadConfigBtn) {
    reloadConfigBtn.addEventListener('click', () => {
      if (configParser) {
        renderArchitecture();
        showNotification('\u2713 Configuration reloaded');
      }
    });
  }

  if (modelViewBtn) {
    modelViewBtn.addEventListener('click', () => {
      _archDiagramMode = _archDiagramMode === 'model' ? 'flow' : 'model';
      modelViewBtn.classList.toggle('btn-primary', _archDiagramMode === 'model');
      modelViewBtn.textContent = _archDiagramMode === 'model' ? 'Flow View' : 'Model View';
      renderArchitectureDiagram();
    });
  }

  if (matrixBtn) {
    matrixBtn.addEventListener('click', renderCoverageMatrix);
  }

  if (closeMatrixBtn) {
    closeMatrixBtn.addEventListener('click', () => {
      const modal = document.getElementById('coverageMatrixModal');
      if (modal) modal.style.display = 'none';
    });
  }

  // Close coverage matrix on overlay click
  const matrixModal = document.getElementById('coverageMatrixModal');
  if (matrixModal) {
    matrixModal.addEventListener('click', (e) => {
      if (e.target === matrixModal) matrixModal.style.display = 'none';
    });
  }

  // Entity Browser Buttons & Filters

  // RDM Reference Data import
  const importRDMBtn   = document.getElementById('importRDMBtn');
  const importRDMInput = document.getElementById('importRDMInput');
  if (importRDMBtn && importRDMInput && !importRDMBtn._handlerAttached) {
    importRDMBtn._handlerAttached = true;
    importRDMBtn.addEventListener('click', () => { importRDMInput.value = ''; importRDMInput.click(); });
    importRDMInput.addEventListener('change', async () => {
      const file = importRDMInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const parsed = parseRDMData(Array.isArray(json) ? json : [json]);
        _rdmData = parsed;
        await saveRDMToDB(parsed);
        const typeCount = Object.keys(parsed).length;
        const valCount  = Object.values(parsed).reduce((s, t) => s + t.values.length, 0);
        showNotification(`✓ Reference data imported — ${typeCount} lookup types, ${valCount} values`);
        // Refresh current tab if lineage or entity detail is open
        if (document.getElementById('lineage')?.classList.contains('active')) renderLineage();
        importRDMInput.value = '';
      } catch (err) {
        console.error('[RDM] Import failed:', err);
        showNotification('✗ Failed to parse reference data file');
      }
    });
  }

  // Dataloader Mappings import (Entity Browser)
  const importDLBtn   = document.getElementById('importDLMappingsBtn');
  const importDLInput = document.getElementById('importDLMappingsInput');
  if (importDLBtn && importDLInput && !importDLBtn._handlerAttached) {
    importDLBtn._handlerAttached = true;
    importDLBtn.addEventListener('click', () => { importDLInput.value = ''; importDLInput.click(); });
    importDLInput.addEventListener('change', async () => {
      const file = importDLInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const parsed = parseDataloaderMappings(Array.isArray(json) ? json : [json]);
        _dataloaderMappings  = parsed.attrs;
        _dataloaderFieldMaps = parsed.fieldMaps;
        await saveDLMappingsToDB(parsed.attrs, parsed.fieldMaps);
        const entityCount = Object.keys(parsed.attrs).length;
        showNotification(`✓ DL Mappings imported — ${entityCount} entity type${entityCount !== 1 ? 's' : ''}`);
        renderEntityTable();
        importDLInput.value = '';
      } catch (err) {
        console.error('[DL mappings] Import failed:', err);
        showNotification('✗ Failed to parse mappings file');
      }
    });
  }

  const exportEntitiesBtn = document.getElementById('exportEntities');
  if (exportEntitiesBtn) {
    exportEntitiesBtn.addEventListener('click', () => {
      if (!configParser) return;
      const csv = 'Entity,Attributes,Relationships,Survivorship\n' +
        configParser.entities.map(e => 
          `${e.label},${e.attributeCount},${e.relationshipCount},${e.survivorshipGroupCount}`
        ).join('\n');
      downloadFile(csv, 'entities.csv', 'text/csv');
      showNotification('✓ Entities exported as CSV');
    });
  }

  const showEntityJsonBtn = document.getElementById('showEntityJson');
  if (showEntityJsonBtn) {
    showEntityJsonBtn.addEventListener('click', () => {
      if (!configParser) return;
      alert('Entity configuration:\n\n' + JSON.stringify(configParser.rawConfig.entityTypes?.slice(0, 1), null, 2).substring(0, 500) + '...');
    });
  }

  const entitySearchInput = document.getElementById('entitySearch');
  if (entitySearchInput) {
    entitySearchInput.addEventListener('input', (e) => {
      filterEntityTable(e.target.value, document.getElementById('filterGroups')?.value || '');
    });
  }

  const filterGroupsSelect = document.getElementById('filterGroups');
  if (filterGroupsSelect) {
    filterGroupsSelect.addEventListener('change', (e) => {
      filterEntityTable(document.getElementById('entitySearch')?.value || '', e.target.value);
    });
  }

  const filterHasIntegrationsBtn = document.getElementById('filterHasIntegrations');
  if (filterHasIntegrationsBtn) {
    filterHasIntegrationsBtn.addEventListener('click', () => {
      filterEntityTableByRelationships(true);
      filterHasIntegrationsBtn.classList.toggle('active');
    });
  }

  const filterHasSurvivorshipBtn = document.getElementById('filterHasSurvivorship');
  if (filterHasSurvivorshipBtn) {
    filterHasSurvivorshipBtn.addEventListener('click', () => {
      filterEntityTableBySurvivorship(true);
      filterHasSurvivorshipBtn.classList.toggle('active');
    });
  }

  const filterGapsBtn = document.getElementById('filterIntegrationGaps');
  if (filterGapsBtn) {
    filterGapsBtn.addEventListener('click', () => {
      const isActive = filterGapsBtn.classList.toggle('active');
      if (isActive) {
        filterEntityTableByGaps();
      } else {
        filterEntityTable('', '');
      }
    });
  }

  // Recipes Tab Buttons
  const exportRecipesBtn = document.getElementById('exportRecipes');
  if (exportRecipesBtn) {
    exportRecipesBtn.addEventListener('click', () => {
      if (!configParser) return;
      const json = JSON.stringify(configParser.survivorshipStrategies, null, 2);
      downloadFile(json, 'survivorship-strategies.json', 'application/json');
      showNotification('✓ Strategies exported as JSON');
    });
  }

  const openRecipeLineageBtn = document.getElementById('openRecipeLineage');
  if (openRecipeLineageBtn) {
    openRecipeLineageBtn.addEventListener('click', () => {
      switchTab('lineage');
    });
  }

  // Registry Tab Buttons
  const exportRegistryBtn = document.getElementById('exportRegistry');
  if (exportRegistryBtn) {
    exportRegistryBtn.addEventListener('click', () => {
      const connections = getAvailableSystems();
      if (!connections.length) { showNotification('No systems to export'); return; }
      const csv = 'System,Direction,Recipes,Steps,FieldMappings\n' +
        connections.map(c =>
          `"${c.label}",${c.direction},${c.totalRecipes || 0},${c.steps ? c.steps.length : 0},${c.fieldMappings ? c.fieldMappings.length : 0}`
        ).join('\n');
      downloadFile(csv, 'integration-registry.csv', 'text/csv');
      showNotification('✓ Registry exported as CSV');
    });
  }

  // Lineage Tab Buttons
  const exportLineageBtn = document.getElementById('exportLineage');
  if (exportLineageBtn) {
    exportLineageBtn.addEventListener('click', () => {
      if (!configParser) return;
      const lineageData = JSON.stringify(configParser.rawConfig, null, 2);
      downloadFile(lineageData, 'lineage-export.json', 'application/json');
      showNotification('✓ Lineage exported as JSON');
    });
  }

  const viewImpactReportBtn = document.getElementById('viewImpactReport');
  if (viewImpactReportBtn) {
    viewImpactReportBtn.addEventListener('click', () => {
      if (!configParser) return;
      const report = generateImpactReport();
      alert(report);
    });
  }
};

// Helper Functions
function filterEntityTable(searchTerm, groupFilter) {
  if (!configParser) return;
  const tbody = document.getElementById('entityTable');
  let filtered = configParser.entities;

  if (searchTerm) {
    filtered = filtered.filter(e => e.label.toLowerCase().includes(searchTerm.toLowerCase()));
  }

  if (groupFilter) {
    filtered = filtered.filter(e => e.label.split(' ')[0] === groupFilter);
  }

  tbody.innerHTML = filtered.map((entity) => {
    const idx = configParser.entities.indexOf(entity);
    return `<tr onclick="showEntityDetail(${idx})" style="cursor:pointer;border-bottom:1px solid rgba(148,163,184,0.1);">
      <td style="padding:0.75rem;"><a href="javascript:void(0)" title="${escapeHtml(entity.description)}" style="color:#38bdf8;text-decoration:none;">${escapeHtml(entity.label)}</a></td>
      <td style="padding:0.75rem;">${escapeHtml(entity.label.split(' ')[0])}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.attributeCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.relationshipCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.survivorshipGroupCount}</td>
      <td style="padding:0.75rem;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>`;
  }).join('');

  document.getElementById('entityCount').textContent = `Showing ${filtered.length} of ${configParser.entities.length} entities`;
}

function filterEntityTableByRelationships(hasIntegrations) {
  if (!configParser) return;
  const tbody = document.getElementById('entityTable');
  const filtered = hasIntegrations
    ? configParser.entities.filter(e => e.relationshipCount > 0)
    : configParser.entities;

  tbody.innerHTML = filtered.map((entity) => {
    const idx = configParser.entities.indexOf(entity);
    return `<tr onclick="showEntityDetail(${idx})" style="cursor:pointer;border-bottom:1px solid rgba(148,163,184,0.1);">
      <td style="padding:0.75rem;"><a href="javascript:void(0)" title="${escapeHtml(entity.description)}" style="color:#38bdf8;text-decoration:none;">${escapeHtml(entity.label)}</a></td>
      <td style="padding:0.75rem;">${escapeHtml(entity.label.split(' ')[0])}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.attributeCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.relationshipCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.survivorshipGroupCount}</td>
      <td style="padding:0.75rem;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>`;
  }).join('');

  document.getElementById('entityCount').textContent = `Showing ${filtered.length} of ${configParser.entities.length} entities (filtered)`;
}

function filterEntityTableBySurvivorship(hasSurvivorship) {
  if (!configParser) return;
  const tbody = document.getElementById('entityTable');
  const filtered = hasSurvivorship
    ? configParser.entities.filter(e => e.survivorshipGroupCount > 0)
    : configParser.entities;

  tbody.innerHTML = filtered.map((entity) => {
    const idx = configParser.entities.indexOf(entity);
    return `<tr onclick="showEntityDetail(${idx})" style="cursor:pointer;border-bottom:1px solid rgba(148,163,184,0.1);">
      <td style="padding:0.75rem;"><a href="javascript:void(0)" title="${escapeHtml(entity.description)}" style="color:#38bdf8;text-decoration:none;">${escapeHtml(entity.label)}</a></td>
      <td style="padding:0.75rem;">${escapeHtml(entity.label.split(' ')[0])}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.attributeCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.relationshipCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.survivorshipGroupCount}</td>
      <td style="padding:0.75rem;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>`;
  }).join('');

  document.getElementById('entityCount').textContent = `Showing ${filtered.length} of ${configParser.entities.length} entities (filtered)`;
}

// ─── Integration Gaps Filter ──────────────────────────────────────────────────
// Shows entities that have coverage issues: no integration at all, DL only (no recipe),
// or recipe only (no DL mapping). Each row carries a colored risk badge.
function filterEntityTableByGaps() {
  if (!configParser) return;

  const recipeIdx = buildRecipeEntityIndex();
  const tbody     = document.getElementById('entityTable');

  const BADGE = {
    none:    { cls: 'gap-badge--none',   label: 'No Integration' },
    dlOnly:  { cls: 'gap-badge--dl',     label: 'DL Only'        },
    recOnly: { cls: 'gap-badge--recipe', label: 'Recipe Only'    },
  };

  const gapRows = [];
  configParser.entities.forEach((entity, idx) => {
    const hasRecipe = recipeIdx && Object.values(recipeIdx).some(d => d.entities.has(entity.label));
    const hasDL     = _dataloaderMappings && !!_dataloaderMappings[entity.uri];
    if (hasRecipe && hasDL) return; // fully covered — not a gap
    const type = (!hasRecipe && !hasDL) ? 'none' : (!hasRecipe && hasDL) ? 'dlOnly' : 'recOnly';
    const badge = BADGE[type];
    gapRows.push(`<tr onclick="showEntityDetail(${idx})" style="cursor:pointer;border-bottom:1px solid rgba(148,163,184,0.1);">
      <td style="padding:0.75rem;">
        <a href="javascript:void(0)" title="${escapeHtml(entity.description)}" style="color:#38bdf8;text-decoration:none;">${escapeHtml(entity.label)}</a>
        <span class="gap-badge ${badge.cls}">${badge.label}</span>
      </td>
      <td style="padding:0.75rem;">${escapeHtml(entity.label.split(' ')[0])}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.attributeCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.relationshipCount}</td>
      <td style="padding:0.75rem;text-align:center;">${entity.survivorshipGroupCount}</td>
      <td style="padding:0.75rem;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>`);
  });

  tbody.innerHTML = gapRows.length
    ? gapRows.join('')
    : '<tr><td colspan="6" style="padding:1.5rem;text-align:center;color:#94a3b8;">\u2713 No integration gaps detected — all entities have coverage</td></tr>';

  document.getElementById('entityCount').textContent =
    `${gapRows.length} gap${gapRows.length !== 1 ? 's' : ''} found of ${configParser.entities.length} entities`;
}

function updateLineageAttributes() {
  if (!configParser) return;
  const entityUri = document.getElementById('lineageEntity').value;
  const entity = configParser.entities.find(e => e.uri === entityUri);
  const attrSelect = document.getElementById('lineageAttribute');

  if (entity && entity.attributes) {
    attrSelect.innerHTML = entity.attributes.slice(0, 10)
      .map(attr => `<option value="${attr.uri}">${attr.label}</option>`)
      .join('');
  }
}

function generateImpactReport() {
  if (!configParser) return 'No configuration loaded';
  
  const report = `
IMPACT REPORT
=============

Configuration Summary:
- Total Entities: ${configParser.entities.length}
- Total Attributes: ${configParser.attributes.length}
- Total Relationships: ${configParser.relationships.length}
- Data Sources: ${configParser.sources.length}
- Survivorship Strategies: ${configParser.survivorshipStrategies.length}
- Graph Types: ${configParser.graphTypes.length}

Entity Breakdown:
- Concrete Entities: ${configParser.entities.filter(e => !e.isAbstract).length}
- Abstract Entities: ${configParser.entities.filter(e => e.isAbstract).length}
- Nested Attributes: ${configParser.attributes.filter(a => a.isNested).length}

Source Integration:
${configParser.sources.map(s => `- ${s.label} (${s.abbreviation || 'N/A'})`).join('\n')}

Top Relationships:
${configParser.relationships.slice(0, 5).map(r => 
  `- ${r.label || r.uri.split('/').pop()}: ${r.startObject?.objectTypeURI?.split('/').pop() || 'N/A'} → ${r.endObject?.objectTypeURI?.split('/').pop() || 'N/A'}`
).join('\n')}
  `.trim();

  return report;
}

function downloadFile(content, filename, mimeType) {
  const element = document.createElement('a');
  element.setAttribute('href', `data:${mimeType};charset=utf-8,` + encodeURIComponent(content));
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

// Navigation helpers
function applyArchitectureFilter(type, value) {
  // Toggle multi-select filter from diagram node click
  if (type === 'group') {
    if (_archGroupFilter.has(value)) _archGroupFilter.delete(value);
    else _archGroupFilter.add(value);
  } else if (type === 'source') {
    if (_archSourceFilter.has(value)) _archSourceFilter.delete(value);
    else _archSourceFilter.add(value);
  }
  // Re-render sidebar and diagram to reflect new selection
  renderEntityGroups();
  renderIntegrationSystems();
  renderArchitectureDiagram();
}

function navigateToEntity(entityIndex) {
  // Navigate to entity browser tab and show entity detail via centralized switchTab
  if (!configParser) return;
  try {
    switchTab('entities');
    // Defer to ensure entity browser renders before showing details
    setTimeout(() => showEntityDetail(entityIndex), 0);
  } catch (err) {
    console.error('navigateToEntity error:', err);
  }
}

function navigateToEntityBrowser(entityIndex) {
  // Simpler version for diagram hyperlinks
  navigateToEntity(entityIndex);
}

// Show quick view for entity attributes when clicked from diagram
function showEntityQuickView(entityIndex) {
  if (!configParser || !window.diagramEntities || entityIndex >= window.diagramEntities.length) return;
  
  const entity = window.diagramEntities[entityIndex];
  
  // Find the actual entity index in configParser.entities (they might not match due to filtering)
  const actualEntityIndex = configParser.entities.findIndex(e => e.label === entity.label);
  const finalIndex = actualEntityIndex >= 0 ? actualEntityIndex : 0; // fallback to first entity
  
  const attrHtml = entity.attributes.slice(0, 10).map(attr => `
    <li style="padding: 8px 0; border-bottom: 1px solid rgba(148,163,184,0.1);">
      <strong>${attr.label}</strong> <span style="color: #64748b; font-size: 0.9em;">: ${attr.type}</span>
    </li>
  `).join('');
  
  const popup = document.createElement('div');
  popup.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: #1a2540;
    border: 2px solid #38bdf8;
    border-radius: 8px;
    padding: 24px;
    max-width: 400px;
    max-height: 70vh;
    overflow-y: auto;
    z-index: 10000;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  `;
  
  popup.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #38bdf8; padding-bottom: 12px;">
      <h3 style="margin: 0; color: #38bdf8; font-size: 1.2em;">${entity.label}</h3>
      <button id="popup-close-btn" style="background: none; border: none; color: #64748b; cursor: pointer; font-size: 1.5em; padding: 0;">✕</button>
    </div>
    
    <div style="margin-bottom: 16px; color: #94a3b8;">
      <p style="margin: 0 0 8px 0;"><strong>Type:</strong> ${entity.isAbstract ? 'Abstract' : 'Concrete'}</p>
      <p style="margin: 0 0 8px 0;"><strong>Attributes:</strong> ${entity.attributeCount}</p>
      <p style="margin: 0;"><strong>Relationships:</strong> ${entity.relationshipCount}</p>
    </div>
    
    <div style="margin-bottom: 16px;">
      <h4 style="margin: 0 0 8px 0; color: #38bdf8;">Attributes (showing ${Math.min(10, entity.attributeCount)} of ${entity.attributeCount})</h4>
      <ul style="margin: 0; padding: 0; list-style: none; color: #e0e7ff;">
        ${attrHtml || '<li style="color: #64748b;">No attributes defined</li>'}
      </ul>
    </div>
    
    <button id="popup-navigate-btn" style="width: 100%; padding: 12px; background: #38bdf8; color: #0f172a; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; font-size: 0.95em;">
      View Attributes in Entity Browser →
    </button>
  `;
  
  // Dark overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 9999;
  `;
  
  // Close button handler
  const closeBtn = popup.querySelector('#popup-close-btn');
  closeBtn.addEventListener('click', () => {
    overlay.remove();
    popup.remove();
  });
  
  // Navigate button handler
  const navigateBtn = popup.querySelector('#popup-navigate-btn');
  navigateBtn.addEventListener('click', () => {
    overlay.remove();
    popup.remove();
    setTimeout(() => {
      navigateToEntity(finalIndex);
    }, 0);
  });
  
  // Close on overlay click
  overlay.addEventListener('click', () => {
    overlay.remove();
    popup.remove();
  });
  
  document.body.appendChild(overlay);
  document.body.appendChild(popup);
}

// Initial load
window.addEventListener('DOMContentLoaded', async () => {
  // Always restore config from localStorage first (needed by all tabs)
  const savedConfig = localStorage.getItem('reltioConfig');
  if (savedConfig) {
    try {
      const json = JSON.parse(savedConfig);
      configParser = new ReltioConfigParser(json);
    } catch (error) {
      console.error('Failed to restore config from localStorage:', error);
    }
  }

  // Restore recipes from IndexedDB
  let recipesData = null;
  try {
    recipesData = await loadRecipesFromDB();
  } catch {}
  if (recipesData) {
    recipeConnections = extractRecipeConnections(recipesData);
  }

  // Restore Dataloader mappings from IndexedDB
  try {
    const dlData = await loadDLMappingsFromDB();
    if (dlData) {
      _dataloaderMappings  = dlData.attrs  || (typeof dlData === 'object' && !dlData.attrs ? dlData : null);
      _dataloaderFieldMaps = dlData.fieldMaps || null;
    }
  } catch {}

  // Restore RDM reference data from IndexedDB
  try { _rdmData = await loadRDMFromDB(); } catch {}

  // Decide which tab to show on load
  if (configParser) {
    renderTab('architecture');
  } else if (recipesData) {
    renderTab('recipes');
  } else {
    // Nothing saved — load sample config as default
    await loadSampleConfig();
  }

  initializeButtons();
});

// Expose functions called from inline onclick handlers (required for type="module" scripts)
window.showEntityDetail      = showEntityDetail;
window.showRegistryDetail    = showRegistryDetail;
window.closeRecipeStepDetail = closeRecipeStepDetail;
window._toggleEntityUnmapped = (idx) => {
  _entityDetailShowUnmapped[idx] = !_entityDetailShowUnmapped[idx];
  showEntityDetail(idx);
};
