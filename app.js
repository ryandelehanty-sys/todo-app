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
      logLevel: 'debug'
    });
    console.log('Mermaid initialized successfully');
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
let architectureFilter = null; // Track selected filter: 'group', 'source', or null

// Tab management (consolidated)
function renderTab(tabId) {
  if (!configParser) return;
  if (tabId === 'architecture') renderArchitecture();
  else if (tabId === 'entities') renderEntityBrowser();
  else if (tabId === 'recipes') renderRecipes();
  else if (tabId === 'mappings') renderMappings();
  else if (tabId === 'registry') renderRegistry();
  else if (tabId === 'lineage') renderLineage();
}

function switchTab(tabId) {
  try {
    console.log('switchTab called for:', tabId);
    const buttons = document.querySelectorAll('.tab-button');
    const panels = document.querySelectorAll('.tab-panel');
    buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    panels.forEach(p => p.classList.toggle('active', p.id === tabId));

    const panel = document.getElementById(tabId);
    if (panel) panel.scrollTop = 0;

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
      console.log('Captured tab click (delegation):', tab.dataset.tab);
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
    console.log('click trace saved:', window.lastClickTrace);
  } catch (err) {
    console.error('click tracer error:', err);
  }
}, true);

// Keyboard shortcuts: Alt+1..6 navigate tabs (handy for testing)
document.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const map = { '1': 'architecture', '2': 'entities', '3': 'recipes', '4': 'mappings', '5': 'registry', '6': 'lineage' };
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
    renderTab('architecture');
    showNotification('✓ Sample configuration loaded');
  } catch (error) {
    showNotification('✗ Failed to load sample config');
    console.error(error);
  }
}

// Render Architecture
function renderArchitecture() {
  if (!configParser) return;
  updateMetrics();
  renderEntityGroups();
  renderIntegrationSystems();
  renderConfigFiles();
  renderArchitectureDiagram();
  setupArchitectureFilterHandlers();
}

function setupArchitectureFilterHandlers() {
  // Only attach handlers once to avoid duplicate listeners on repeated renders
  if (window._architectureFiltersInitialized) return;
  window._architectureFiltersInitialized = true;

  // Entity Groups - make clickable
  const entityGroupsContainer = document.getElementById('entityGroups');
  if (entityGroupsContainer) {
    entityGroupsContainer.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (!item) return;
      
      const filterValue = item.dataset.filterValue;
      const filterType = item.dataset.filterType;
      
      if (!filterValue || !filterType) return;
      
      // Check if already active
      if (architectureFilter?.type === filterType && architectureFilter?.value === filterValue) {
        // Clear filter on double-click
        architectureFilter = null;
        item.classList.remove('active');
      } else {
        // Remove active class from all items in this section
        entityGroupsContainer.querySelectorAll('.sidebar-item').forEach(el => {
          el.classList.remove('active');
        });
        
        // Add active class to clicked item
        item.classList.add('active');
        
        // Set filter and re-render diagram
        architectureFilter = { type: filterType, value: filterValue };
      }
      
      renderArchitectureDiagram();
    });
  }

  // Integration Systems - make clickable
  const integrationsContainer = document.getElementById('integrationSystems');
  if (integrationsContainer) {
    integrationsContainer.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (!item) return;
      
      const filterValue = item.dataset.filterValue;
      const filterType = item.dataset.filterType;
      
      if (!filterValue || !filterType) return;
      
      // Check if already active
      if (architectureFilter?.type === filterType && architectureFilter?.value === filterValue) {
        // Clear filter on double-click
        architectureFilter = null;
        item.classList.remove('active');
      } else {
        // Remove active class from all items in this section
        integrationsContainer.querySelectorAll('.sidebar-item').forEach(el => {
          el.classList.remove('active');
        });
        
        // Add active class to clicked item
        item.classList.add('active');
        
        // Set filter and re-render diagram
        architectureFilter = { type: filterType, value: filterValue };
      }
      
      renderArchitectureDiagram();
    });
  }

  // Config Files - clicking on these clears filter
  const configFilesContainer = document.getElementById('configFiles');
  if (configFilesContainer) {
    configFilesContainer.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar-item');
      if (!item) return;
      
      // Clear filter if clicking on config info
      architectureFilter = null;
      
      // Remove active classes
      entityGroupsContainer?.querySelectorAll('.sidebar-item').forEach(el => {
        el.classList.remove('active');
      });
      integrationsContainer?.querySelectorAll('.sidebar-item').forEach(el => {
        el.classList.remove('active');
      });
      
      renderArchitectureDiagram();
    });
  }
}

function updateMetrics() {
  document.getElementById('totalEntities').textContent = configParser.entities.length;
  document.getElementById('totalAttributes').textContent = configParser.attributes.length;
  document.getElementById('recipeCount').textContent = configParser.survivorshipStrategies.length;
  document.getElementById('mappingCount').textContent = configParser.sources.length;
  document.getElementById('relationshipCount').textContent = configParser.relationships.length;
}

function renderEntityGroups() {
  const groups = configParser.entities.reduce((acc, entity) => {
    const group = entity.label.split(' ')[0];
    if (!acc[group]) acc[group] = 0;
    acc[group]++;
    return acc;
  }, {});

  const html = Object.entries(groups).map(([group, count]) => 
    `<div class="sidebar-item" style="cursor: pointer;" data-filter-type="group" data-filter-value="${group}">
      ${group} <span class="badge">${count}</span>
    </div>`
  ).join('');
  
  document.getElementById('entityGroups').innerHTML = html;
}

function renderIntegrationSystems() {
  const systemGroups = configParser.sources.reduce((acc, source) => {
    const system = source.label;
    if (!acc[system]) acc[system] = 0;
    acc[system]++;
    return acc;
  }, {});

  const html = Object.entries(systemGroups).slice(0, 8).map(([system, count]) =>
    `<div class="sidebar-item" style="cursor: pointer;" data-filter-type="source" data-filter-value="${system}">
      ${system} <span class="badge">${count}</span>
    </div>`
  ).join('');
  
  document.getElementById('integrationSystems').innerHTML = html;
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
  
  let entities = configParser.entities;
  let sources = configParser.sources;
  
  // Apply filters based on selection
  if (architectureFilter) {
    if (architectureFilter.type === 'group') {
      entities = configParser.entities.filter(e => e.label.split(' ')[0] === architectureFilter.value);
    } else if (architectureFilter.type === 'source') {
      sources = configParser.sources.filter(s => s.label === architectureFilter.value);
    }
  }
  
  entities = entities.slice(0, 8);
  sources = sources.slice(0, 6);
  
  // Sanitize labels - remove problematic characters
  const sanitize = (str) => {
    return str
      .replace(/&/g, ' and ')           // Replace & with 'and'
      .replace(/[<>]/g, '')              // Remove angle brackets
      .replace(/"/g, "'")                // Replace " with '
      .trim();
  };
  
  let def = 'flowchart LR\n';
  
  // Build entity subgraph - include attribute counts
  def += '  subgraph entities["Entity Types"]\n';
  entities.forEach((entity, idx) => {
    const safeLabel = sanitize(entity.label);
    const attrDisplay = entity.attributeCount ? ` (${entity.attributeCount})` : '';
    def += `    E${idx}["${safeLabel}${attrDisplay}"]\n`;
  });
  def += '  end\n\n';
  
  // Build sources subgraph
  def += '  subgraph sources_group["Data Sources"]\n';
  sources.forEach((source, idx) => {
    const safeLabel = sanitize(source.label);
    def += `    S${idx}["${safeLabel}"]\n`;
  });
  def += '  end\n\n';
  
  // Add connections with distribution
  const entityCount = entities.length;
  const sourceCount = sources.length;
  
  if (entityCount > 0 && sourceCount > 0) {
    sources.forEach((_, sidx) => {
      for (let i = 0; i < entityCount; i++) {
        if (sourceCount === 1 || i % Math.max(2, Math.ceil(entityCount / sourceCount)) === sidx % entityCount) {
          def += `  S${sidx} --> E${i}\n`;
        }
      }
      if (sourceCount > 1 && sidx < entityCount) {
        def += `  S${sidx} --> E${sidx % entityCount}\n`;
      } else if (sourceCount > 1) {
        def += `  S${sidx} --> E${(sidx + Math.floor(entityCount / 2)) % entityCount}\n`;
      }
    });
  }
  
  // Add styling
  def += '  classDef entity fill:#1e40af,stroke:#38bdf8,color:#fff,stroke-width:2px\n';
  def += '  classDef source fill:#1e3a8a,stroke:#60a5fa,color:#fff\n';
  
  // Apply classes
  const entityClasses = entities.map((_, i) => `E${i}`).join(',');
  const sourceClasses = sources.map((_, i) => `S${i}`).join(',');
  
  if (entityClasses) def += `  class ${entityClasses} entity\n`;
  if (sourceClasses) def += `  class ${sourceClasses} source\n`;
  
  // Debug log
  console.log('Mermaid Definition:', def);
  
  // Store data for click handling
  window.diagramEntities = entities;
  window.diagramSources = sources;
  
  renderMermaidDiagram('architectureDiagram', def);
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
  
  console.log('Triggering Mermaid render for:', elementId);
  
  // Trigger mermaid rendering
  try {
    if (typeof mermaid !== 'undefined' && typeof mermaid.run === 'function') {
      mermaid.run();
      console.log('Mermaid.run() executed successfully');
    } else if (typeof mermaid !== 'undefined' && typeof mermaid.contentLoaded === 'function') {
      mermaid.contentLoaded();
      console.log('Mermaid.contentLoaded() executed successfully');
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
  if (!configParser) return;
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
      <td style="padding: 0.75rem;"><a title="${entity.description}" style="color:#38bdf8; text-decoration:none;">${entity.label}</a></td>
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

function showEntityDetail(entityIndex) {
  const entity = configParser.entities[entityIndex];
  if (!entity) return;
  
  const detail = document.getElementById('entityDetailContent');
  
  const attrHtml = entity.attributes.slice(0, 20).map(attr => `
    <tr>
      <td style="color: #38bdf8;">${attr.label || 'N/A'}</td>
      <td style="color: #94a3b8; font-size: 0.85em;">${attr.type || 'string'}</td>
      <td style="text-align: center; color: #10b981;">${attr.multiValue ? '✓' : '–'}</td>
    </tr>
  `).join('');
  
  detail.innerHTML = `
    <div style="margin-bottom: 2rem;">
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 2px solid #38bdf8;">
        <div>
          <h2 style="margin: 0; color: #38bdf8; font-size: 1.5em;">${entity.label}</h2>
          <p style="margin: 0.5rem 0 0 0; color: #94a3b8; font-size: 0.9em;">${entity.description || 'No description available'}</p>
        </div>
      </div>
      
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; margin-bottom: 2rem;">
        <div style="display: flex; flex-direction: column;">
          <span style="color: #64748b; font-size: 0.8em; text-transform: uppercase; margin-bottom: 0.5rem;">Type</span>
          <span style="color: #e0e7ff; font-weight: 500;">${entity.isAbstract ? 'Abstract' : 'Concrete'}</span>
        </div>
        <div style="display: flex; flex-direction: column;">
          <span style="color: #64748b; font-size: 0.8em; text-transform: uppercase; margin-bottom: 0.5rem;">Total Attributes</span>
          <span style="color: #e0e7ff; font-weight: 500;">${entity.attributeCount}</span>
        </div>
        <div style="display: flex; flex-direction: column;">
          <span style="color: #64748b; font-size: 0.8em; text-transform: uppercase; margin-bottom: 0.5rem;">Relationships</span>
          <span style="color: #e0e7ff; font-weight: 500;">${entity.relationshipCount}</span>
        </div>
        <div style="display: flex; flex-direction: column;">
          <span style="color: #64748b; font-size: 0.8em; text-transform: uppercase; margin-bottom: 0.5rem;">Survivorship Groups</span>
          <span style="color: #e0e7ff; font-weight: 500;">${entity.survivorshipGroupCount}</span>
        </div>
        <div style="display: flex; flex-direction: column;">
          <span style="color: #64748b; font-size: 0.8em; text-transform: uppercase; margin-bottom: 0.5rem;">Match Groups</span>
          <span style="color: #e0e7ff; font-weight: 500;">${entity.matchGroupCount || 0}</span>
        </div>
        <div style="display: flex; flex-direction: column;">
          <span style="color: #64748b; font-size: 0.8em; text-transform: uppercase; margin-bottom: 0.5rem;">Group</span>
          <span style="color: #38bdf8;">${entity.label.split(' ')[0]}</span>
        </div>
      </div>
    </div>
    
    <div>
      <h3 style="margin: 0 0 1rem 0; padding-bottom: 0.75rem; border-bottom: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; font-size: 1.1em;">🔗 Attributes (${Math.min(20, entity.attributeCount)} of ${entity.attributeCount})</h3>
      ${entity.attributeCount > 0 ? `
        <div style="overflow-x: auto;">
          <table style="width: 100%; font-size: 0.9em;">
            <thead style="background: rgba(56, 189, 248, 0.1); border-bottom: 1px solid rgba(56, 189, 248, 0.2);">
              <tr>
                <th style="padding: 0.75rem; text-align: left; color: #38bdf8; font-weight: 600;">Attribute Name</th>
                <th style="padding: 0.75rem; text-align: left; color: #38bdf8; font-weight: 600;">Type</th>
                <th style="padding: 0.75rem; text-align: center; color: #38bdf8; font-weight: 600; width: 100px;">Multi-Value</th>
              </tr>
            </thead>
            <tbody${attrHtml}</tbody>
          </table>
        </div>
      ` : '<p style="color: #64748b;">No attributes defined for this entity.</p>'}
    </div>
  `;
}

// Recipes (now showing Survivorship Strategies)
function renderRecipes() {
  if (!configParser) return;
  const sidebar = document.getElementById('recipeList');
  const strategies = configParser.survivorshipStrategies.slice(0, 12);
  
  sidebar.innerHTML = strategies.length > 0 ? strategies.map((strategy, idx) =>
    `<div class="sidebar-item" onclick="showStrategyDetail(${idx})">
      ${strategy.label}
    </div>`
  ).join('') : '<div class="sidebar-item" style="color: var(--muted);">No strategies defined</div>';
  
  if (strategies.length > 0) {
    showStrategyDetail(0);
  }
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

// Mappings (showing Sources)
function renderMappings() {
  if (!configParser) return;
  const sidebar = document.getElementById('mappingList');
  const sources = configParser.sources.slice(0, 20);
  
  sidebar.innerHTML = sources.length > 0 ? sources.map((source, idx) =>
    `<div class="sidebar-item" onclick="showSourceDetail(${idx})">
      ${source.label}
      <div style="font-size: 0.75rem; color: var(--muted); margin-top: 0.3rem;">${source.abbreviation || ''}</div>
    </div>`
  ).join('') : '<div class="sidebar-item" style="color: var(--muted);">No sources defined</div>';
  
  if (sources.length > 0) {
    showSourceDetail(0);
  }
}

function showSourceDetail(sourceIndex) {
  const source = configParser.sources[sourceIndex];
  if (!source) return;
  
  const detail = document.getElementById('mappingDetail');
  detail.innerHTML = `
    <div class="detail-header">
      <h2>${source.label}</h2>
    </div>
    <div class="detail-section">
      <h3>📊 Source Configuration</h3>
      <div class="detail-row">
        <div class="detail-label">Label</div>
        <div class="detail-value">${source.label}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">Abbreviation</div>
        <div class="detail-value">${source.abbreviation || 'N/A'}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">URI</div>
        <div class="detail-value" style="font-size: 0.9rem; word-break: break-all;">${source.uri}</div>
      </div>
      ${source.description ? `
        <div class="detail-row">
          <div class="detail-label">Description</div>
          <div class="detail-value">${source.description}</div>
        </div>
      ` : ''}
      ${source.priority ? `
        <div class="detail-row">
          <div class="detail-label">Priority</div>
          <div class="detail-value">${source.priority}</div>
        </div>
      ` : ''}
    </div>
  `;
}

// Registry (Relationships)
function renderRegistry() {
  if (!configParser) return;
  const tbody = document.getElementById('integrationTable');
  
  const relationshipData = configParser.relationships.map(rel => ({
    name: rel.label || rel.uri.split('/').pop(),
    direction: rel.direction || 'directed',
    startEntity: rel.startObject?.objectTypeURI?.split('/').pop() || 'N/A',
    endEntity: rel.endObject?.objectTypeURI?.split('/').pop() || 'N/A',
    implicit: rel.implicit ? 'Yes' : 'No',
    attributes: (rel.attributes || []).length,
    uri: rel.uri
  }));
  
  tbody.innerHTML = relationshipData.length > 0 ? relationshipData.map(rel => `
    <tr title="${rel.uri}">
      <td><strong>${rel.name}</strong></td>
      <td>${rel.startEntity}</td>
      <td>${rel.direction}</td>
      <td><a>${rel.endEntity}</a></td>
      <td>${rel.implicit}</td>
      <td>${rel.attributes}</td>
    </tr>
  `).join('') : '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No relationships defined</td></tr>';
}

// Lineage
function renderLineage() {
  if (!configParser) return;
  renderLineageDiagram();
  renderLineageHops();
  renderImpactSummary();
}

function renderLineageDiagram() {
  if (!configParser || configParser.entities.length === 0) return;
  
  const sources = configParser.sources.slice(0, 3);
  const entities = configParser.entities.slice(0, 3);
  
  let def = 'flowchart LR\n';
  def += '  subgraph source["SOURCES (' + configParser.sources.length + ')"]\n';
  sources.forEach((s, i) => def += `    S${i}["${s.abbreviation || s.label.substring(0, 10)}"]\n`);
  def += '  end\n\n  subgraph mdm["MDM LAYER (' + configParser.entities.length + ')"]\n';
  entities.forEach((e, i) => def += `    E${i}["${e.label}"]\n`);
  def += '  end\n\n  subgraph rels["RELATIONSHIPS (' + configParser.relationships.length + ')"]\n';
  def += `    R["${configParser.relationships.length} defined"]\n`;
  def += '  end\n\n';
  
  sources.forEach((_, si) => {
    entities.forEach((_, ei) => {
      def += `  S${si} --> E${ei}\n`;
    });
  });
  
  entities.forEach((_, ei) => {
    def += `  E${ei} -> R\n`;
  });
  
  def += '\n  classDef source fill:#1e3a8a,stroke:#60a5fa,color:#fff\n';
  def += '  classDef mdm fill:#1e40af,stroke:#38bdf8,color:#fff,stroke-width:2px\n';
  def += '  classDef rels fill:#7c3aed,stroke:#a78bfa,color:#fff\n';
  def += '  class S0,S1,S2 source\n';
  def += '  class E0,E1,E2 mdm\n';
  def += '  class R rels\n';
  
  renderMermaidDiagram('lineageDiagram', def);
}

function renderLineageHops() {
  if (!configParser) return;
  const hopsContent = [
    `<li><strong>Hop 1:</strong> Data ingest from sources<br/><em>${configParser.sources.length} configured source systems</em></li>`,
    `<li><strong>Hop 2:</strong> MDM consolidation layer<br/><em>${configParser.entities.length} entity types defined</em></li>`,
    `<li><strong>Hop 3:</strong> Entity relationships defined<br/><em>${configParser.relationships.length} relationship types</em></li>`,
    `<li><strong>Hop 4:</strong> Survivorship rules application<br/><em>${configParser.survivorshipStrategies.length} survivorship strategies</em></li>`,
    `<li><strong>Hop 5:</strong> Graph types and grouping<br/><em>${configParser.graphTypes.length} graph type${configParser.graphTypes.length !== 1 ? 's' : ''}</em></li>`,
    `<li><strong>Hop 6:</strong> Master data distribution<br/><em>${configParser.attributes.length} total attributes across all entities</em></li>`
  ];
  document.getElementById('lineageHops').innerHTML = hopsContent.join('');
}

function renderImpactSummary() {
  if (!configParser) return;
  const summary = document.getElementById('impactSummary');
  const nestedAttrCount = configParser.attributes.filter(a => a.isNested).length;
  const abstractEntityCount = configParser.entities.filter(e => e.isAbstract).length;
  const concreteEntityCount = configParser.entities.length - abstractEntityCount;
  
  summary.innerHTML = `
    <h3>📊 Configuration Summary</h3>
    <div class="impact-grid">
      <div class="impact-item">
        <div class="impact-item-label">Entity Types</div>
        <div class="impact-item-value">${configParser.entities.length}</div>
      </div>
      <div class="impact-item">
        <div class="impact-item-label">All Attributes</div>
        <div class="impact-item-value">${configParser.attributes.length}</div>
      </div>
      <div class="impact-item">
        <div class="impact-item-label">Relationships</div>
        <div class="impact-item-value">${configParser.relationships.length}</div>
      </div>
      <div class="impact-item">
        <div class="impact-item-label">Data Sources</div>
        <div class="impact-item-value">${configParser.sources.length}</div>
      </div>
    </div>
    <div style="margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border); font-size: 0.9rem; color: var(--muted);">
      <strong>Entity Types:</strong> ${concreteEntityCount} concrete, ${abstractEntityCount} abstract<br/>
      <strong>Nested Attributes:</strong> ${nestedAttrCount}<br/>
      <strong>Survivorship Strategies:</strong> ${configParser.survivorshipStrategies.length}<br/>
      <strong>Graph Types:</strong> ${configParser.graphTypes.length}
    </div>
  `;
}

// ========== BUTTON HANDLERS ==========

// Architecture Tab Buttons
const initializeButtons = () => {
  const exportSvgBtn = document.getElementById('exportSvg');
  const reloadConfigBtn = document.getElementById('reloadConfig');
  
  if (exportSvgBtn) {
    exportSvgBtn.addEventListener('click', () => {
      showNotification('SVG export coming soon');
    });
  }
  
  if (reloadConfigBtn) {
    reloadConfigBtn.addEventListener('click', () => {
      if (configParser) {
        renderArchitecture();
        showNotification('✓ Configuration reloaded');
      }
    });
  }

  // Entity Browser Buttons & Filters
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

  // Mappings Tab Buttons
  const exportMappingsBtn = document.getElementById('exportMappings');
  if (exportMappingsBtn) {
    exportMappingsBtn.addEventListener('click', () => {
      if (!configParser) return;
      const yaml = 'sources:\n' + 
        configParser.sources.map(s => `  - label: ${s.label}\n    abbreviation: ${s.abbreviation}\n`).join('');
      downloadFile(yaml, 'sf-mappings.yaml', 'text/plain');
      showNotification('✓ Mappings exported as YAML');
    });
  }

  const openMappingLineageBtn = document.getElementById('openMappingLineage');
  if (openMappingLineageBtn) {
    openMappingLineageBtn.addEventListener('click', () => {
      switchTab('lineage');
    });
  }

  // Registry Tab Buttons
  const exportRegistryBtn = document.getElementById('exportRegistry');
  if (exportRegistryBtn) {
    exportRegistryBtn.addEventListener('click', () => {
      if (!configParser) return;
      const csv = 'Name,Start,End,Direction\n' +
        configParser.relationships.map(r =>
          `${r.label || r.uri.split('/').pop()},${r.startObject?.objectTypeURI?.split('/').pop() || 'N/A'},${r.endObject?.objectTypeURI?.split('/').pop() || 'N/A'},${r.direction || 'directed'}`
        ).join('\n');
      downloadFile(csv, 'relationships.csv', 'text/csv');
      showNotification('✓ Relationships exported as CSV');
    });
  }

  const viewInLineageBtn = document.getElementById('viewInLineage');
  if (viewInLineageBtn) {
    viewInLineageBtn.addEventListener('click', () => {
      switchTab('lineage');
    });
  }

  const systemFilterSelect = document.getElementById('systemFilter');
  if (systemFilterSelect && configParser) {
    const systems = [...new Set(configParser.relationships.map(r => 
      r.startObject?.objectTypeURI?.split('/').pop() || 'Unknown'
    ))];
    systemFilterSelect.innerHTML = '<option value="">All Systems</option>' +
      systems.map(s => `<option value="${s}">${s}</option>`).join('');
    
    systemFilterSelect.addEventListener('change', (e) => {
      filterRegistry(e.target.value, document.getElementById('directionFilter')?.value || '');
    });
  }

  const directionFilterSelect = document.getElementById('directionFilter');
  if (directionFilterSelect) {
    directionFilterSelect.addEventListener('change', (e) => {
      filterRegistry(document.getElementById('systemFilter')?.value || '', e.target.value);
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
      const report = generateImpactReport();
      alert(report);
    });
  }

  const lineageEntitySelect = document.getElementById('lineageEntity');
  if (lineageEntitySelect && configParser) {
    lineageEntitySelect.innerHTML = configParser.entities
      .map(e => `<option value="${e.uri}">${e.label}</option>`)
      .join('');
    
    lineageEntitySelect.addEventListener('change', updateLineageAttributes);
  }

  const lineageAttributeSelect = document.getElementById('lineageAttribute');
  if (lineageAttributeSelect) {
    lineageAttributeSelect.addEventListener('change', () => {
      renderLineageDiagram();
      showNotification('✓ Lineage updated');
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

  tbody.innerHTML = filtered.map((entity, idx) => `
    <tr onclick="showEntityDetail(${configParser.entities.indexOf(entity)})">
      <td><a title="${entity.description}">${entity.label}</a></td>
      <td>${entity.label.split(' ')[0]}</td>
      <td>${entity.attributeCount}</td>
      <td><span class="status-indicator active"></span>${entity.relationshipCount}</td>
      <td><span class="status-indicator active"></span>${entity.survivorshipGroupCount}</td>
      <td>${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>
  `).join('');

  document.getElementById('entityCount').textContent = `Showing ${filtered.length} of ${configParser.entities.length} entities`;
}

function filterEntityTableByRelationships(hasIntegrations) {
  if (!configParser) return;
  const tbody = document.getElementById('entityTable');
  const filtered = hasIntegrations 
    ? configParser.entities.filter(e => e.relationshipCount > 0)
    : configParser.entities;

  tbody.innerHTML = filtered.map((entity, idx) => `
    <tr onclick="showEntityDetail(${configParser.entities.indexOf(entity)})">
      <td><a title="${entity.description}">${entity.label}</a></td>
      <td>${entity.label.split(' ')[0]}</td>
      <td>${entity.attributeCount}</td>
      <td><span class="status-indicator active"></span>${entity.relationshipCount}</td>
      <td><span class="status-indicator active"></span>${entity.survivorshipGroupCount}</td>
      <td>${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>
  `).join('');

  document.getElementById('entityCount').textContent = `Showing ${filtered.length} of ${configParser.entities.length} entities (filtered)`;
}

function filterEntityTableBySurvivorship(hasSurvivorship) {
  if (!configParser) return;
  const tbody = document.getElementById('entityTable');
  const filtered = hasSurvivorship
    ? configParser.entities.filter(e => e.survivorshipGroupCount > 0)
    : configParser.entities;

  tbody.innerHTML = filtered.map((entity, idx) => `
    <tr onclick="showEntityDetail(${configParser.entities.indexOf(entity)})">
      <td><a title="${entity.description}">${entity.label}</a></td>
      <td>${entity.label.split(' ')[0]}</td>
      <td>${entity.attributeCount}</td>
      <td><span class="status-indicator active"></span>${entity.relationshipCount}</td>
      <td><span class="status-indicator active"></span>${entity.survivorshipGroupCount}</td>
      <td>${entity.isAbstract ? 'Abstract' : 'Concrete'}</td>
    </tr>
  `).join('');

  document.getElementById('entityCount').textContent = `Showing ${filtered.length} of ${configParser.entities.length} entities (filtered)`;
}

function filterRegistry(system, direction) {
  if (!configParser) return;
  const tbody = document.getElementById('integrationTable');
  let filtered = configParser.relationships;

  if (system) {
    filtered = filtered.filter(r => r.startObject?.objectTypeURI?.includes(system));
  }

  if (direction) {
    filtered = filtered.filter(r => r.direction === direction || (direction === 'Bidirectional' && !r.direction));
  }

  const relationshipData = filtered.map(rel => ({
    name: rel.label || rel.uri.split('/').pop(),
    direction: rel.direction || 'directed',
    startEntity: rel.startObject?.objectTypeURI?.split('/').pop() || 'N/A',
    endEntity: rel.endObject?.objectTypeURI?.split('/').pop() || 'N/A',
    implicit: rel.implicit ? 'Yes' : 'No',
    attributes: (rel.attributes || []).length,
    uri: rel.uri
  }));

  tbody.innerHTML = relationshipData.length > 0 ? relationshipData.map(rel => `
    <tr title="${rel.uri}">
      <td><strong>${rel.name}</strong></td>
      <td>${rel.startEntity}</td>
      <td>${rel.direction}</td>
      <td><a>${rel.endEntity}</a></td>
      <td>${rel.implicit}</td>
      <td>${rel.attributes}</td>
    </tr>
  `).join('') : '<tr><td colspan="6" style="text-align: center; color: var(--muted);">No matching relationships</td></tr>';
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
  // Filter the architecture diagram as if sidebar item was clicked
  if (architectureFilter?.type === type && architectureFilter?.value === value) {
    // Toggle off if already selected
    architectureFilter = null;
  } else {
    // Set new filter
    architectureFilter = { type: type, value: value };
  }
  
  // Update sidebar active states
  const entityGroupsContainer = document.getElementById('entityGroups');
  const integrationsContainer = document.getElementById('integrationSystems');
  
  if (type === 'group' && entityGroupsContainer) {
    entityGroupsContainer.querySelectorAll('.sidebar-item').forEach(el => {
      el.classList.remove('active');
      if (architectureFilter?.value === value && el.dataset.filterValue === value) {
        el.classList.add('active');
      }
    });
  } else if (type === 'source' && integrationsContainer) {
    integrationsContainer.querySelectorAll('.sidebar-item').forEach(el => {
      el.classList.remove('active');
      if (architectureFilter?.value === value && el.dataset.filterValue === value) {
        el.classList.add('active');
      }
    });
  }
  
  // Re-render the diagram
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
  // Try to restore config from localStorage
  const savedConfig = localStorage.getItem('reltioConfig');
  if (savedConfig) {
    try {
      const json = JSON.parse(savedConfig);
      configParser = new ReltioConfigParser(json);
      renderTab('architecture');
    } catch (error) {
      console.error('Failed to restore config from localStorage:', error);
      await loadSampleConfig();
    }
  } else {
    await loadSampleConfig();
  }
  initializeButtons();
});
