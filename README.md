# MDM Architecture Dashboard - Reltio Configuration Parser

A professional web-based dashboard for visualizing Reltio Master Data Management (MDM) configurations, entity relationships, data sources, and lineage.

## Features

### 1. **Configuration Parser**
- **Automatic JSON parsing** of Reltio configuration files
- Extracts and organizes:
  - Entity types with their attributes (regular and nested)
  - Data sources and integrations
  - Relationship types (directed, bidirectional)
  - Graph types and structures
  - Survivorship strategies
  - Match groups and survivorship groups

### 2. **Dashboard Tabs**

#### Architecture Map
- Visual diagram of entity types and data sources
- Entity groups with attribute counts
- Integration system breakdown
- Configuration file inventory
- Real-time statistics

#### Entity Browser
- Complete list of all entity types
- Filterable by group
- Attribute count and relationship metrics
- Abstract vs. Concrete entity classification
- Detailed entity panel showing:
  - Full attribute list with types and multi-value indicators
  - Survivorship group count
  - Match group count
  - Related relationships

#### Survivorship Strategies (Recipes)
- All defined survivorship strategies
- Supports custom strategies
- Displays source type preferences
- Detailed strategy information

#### Data Sources (Mappings)
- Complete source system inventory
- Priority and abbreviation indicators
- Source descriptions
- URI references
- Usage statistics

#### Integration Registry (Relationships)
- All entity relationships defined
- Shows start/end entities
- Direction indicators (directed/bidirectional)
- Relationship attributes count
- Full URI references for traceability

#### Lineage Explorer
- End-to-end data flow visualization
- Multi-hop lineage tracking:
  - Data ingestion from sources
  - MDM consolidation
  - Entity relationships
  - Survivorship application
  - Graph typing and grouping
  - Master data distribution
- Configuration impact summary

## Configuration File Format

The application expects a Reltio configuration JSON with the following structure:

```json
{
  "uri": "configuration",
  "label": "Configuration Name",
  "sources": [...],
  "entityTypes": [...],
  "relationTypes": [...],
  "graphTypes": [...],
  "survivorshipStrategies": [...]
}
```

### Sources
```json
{
  "uri": "configuration/sources/SystemName",
  "label": "Display Name",
  "abbreviation": "SYS"
}
```

### Entity Types
```json
{
  "uri": "configuration/entityTypes/EntityName",
  "label": "Individual",
  "description": "...",
  "typeColor": "#000066",
  "abstract": false,
  "attributes": [
    {
      "uri": "configuration/entityTypes/Individual/attributes/AttrName",
      "label": "Display Name",
      "type": "string",
      "multiValue": false,
      "attributes": [...]  // nested attributes
    }
  ],
  "survivorshipGroups": [...],
  "matchGroups": [...]
}
```

### Relationship Types
```json
{
  "uri": "configuration/relationTypes/RelName",
  "label": "Individual Has Address",
  "startObject": {
    "objectTypeURI": "configuration/entityTypes/Individual"
  },
  "endObject": {
    "objectTypeURI": "configuration/entityTypes/Location"
  },
  "direction": "directed",
  "implicit": false
}
```

### Graph Types
```json
{
  "uri": "configuration/graphTypes/GraphName",
  "label": "Organization Hierarchy",
  "type": "logical",
  "layout": "hierarchy",
  "graphStructure": "hierarchy"
}
```

### Survivorship Strategies
```json
{
  "uri": "configuration/survivorshipStrategies/StrategyName",
  "label": "Source Priority",
  "winnerSourceType": "configuration/sources/SourceName"
}
```

## Usage

### Running the Application

1. Start the PowerShell HTTP server:
```powershell
.\server.ps1
```

2. Open in browser: `http://localhost:5500`

### Loading Configurations

**Option 1: Load Sample Configuration**
- Click "Load Sample" button on page load
- Uses built-in `sample-config.json`

**Option 2: Upload Custom Configuration**
- Click "Upload Configuration" button
- Select a Reltio configuration JSON file
- Parser validates and loads automatically
- Dashboard refreshes with new data

## Parser Features

### Nested Attribute Extraction
- Recursively extracts all attribute levels
- Tracks nesting depth for hierarchy visualization
- Identifies multi-value vs. single-value attributes
- Maintains parent-child relationships

### Relationship Counting
- Counts relationships per entity
- Tracks both directions (start and end entities)
- Identifies relationship types and attributes

### Validation
- Validate JSON syntax
- Checks for required fields
- Reports parsing errors clearly

## Technology Stack

- **Frontend**: HTML5, CSS3, JavaScript ES6
- **Visualization**: Mermaid.js v10 (flowcharts, diagrams)
- **Hosting**: PowerShell HTTP Listener on port 5500
- **No external dependencies** (except Mermaid.js CDN)

## File Structure

```
/todo-app
├── index.html              # Main application page
├── styles.css              # Professional dark theme styles
├── app.js                  # Core application logic & parser
├── sample-config.json      # Sample Reltio configuration
├── server.ps1              # Local HTTP server
└── README.md               # This file
```

## Key Classes and Functions

### ReltioConfigParser
Main parser class for handling Reltio configurations:
- `constructor(config)` - Initialize with config JSON
- `parse()` - Parse all sections
- `parseEntityTypes()` - Extract entity metadata
- `extractAllAttributes()` - Recursively extract all attributes
- `extractAttributesRecursively()` - Handle nested attributes
- `countEntityRelationships()` - Calculate relationship metrics

### Render Functions
- `renderArchitecture()` - Architecture map tab
- `renderEntityBrowser()` - Entity list and browser
- `renderRecipes()` - Survivorship strategies
- `renderMappings()` - Data sources
- `renderRegistry()` - Relationships
- `renderLineage()` - End-to-end flow

## Data Transformation Example

```javascript
// Input: Reltio configuration JSON
{
  "entityTypes": [{
    "label": "Individual",
    "attributes": [
      {
        "label": "Email",
        "type": "array",
        "attributes": [
          { "label": "Email Address" },
          { "label": "Email Type" }
        ]
      }
    ]
  }]
}

// Output: Parsed structure
{
  entities: [{
    label: "Individual",
    attributeCount: 1,
    attributes: [...]
  }],
  attributes: [
    {
      label: "Email",
      entity: "Individual",
      isNested: false,
      depth: 0
    },
    {
      label: "Email Address",
      entity: "Individual",
      isNested: true,
      depth: 1
    },
    {
      label: "Email Type",
      entity: "Individual",
      isNested: true,
      depth: 1
    }
  ]
}
```

## Error Handling

- **File Upload Errors**: Displays user-friendly notifications
- **Parse Errors**: Logs to console with error messages
- **Missing Data**: Graceful fallbacks with appropriate counts
- **Tab Rendering**: Renders with null checks and safe data access

## Browser Support

- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Requires ES6 JavaScript support

## Customization

### Adding New Tabs
1. Add tab button to HTML
2. Create render function in `app.js`
3. Add case to `renderTab()` function
4. Style in `styles.css`

### Modifying Data Display
- Update render functions to change layout
- Modify CSS variables for theming (in `:root`)
- Adjust Mermaid diagram definitions for different visualizations

## Tips for Large Configurations

- Parse operations are optimized for 1000+ entities
- Attribute extraction handles deeply nested structures
- Diagram rendering limits display to first N items for performance
- Use filters in Entity Browser for large datasets

## Troubleshooting

**Configuration won't load:**
- Check JSON syntax validity
- Ensure all required fields are present
- Verify file follows Reltio configuration structure

**Diagrams not rendering:**
- Check browser console for Mermaid errors
- Verify Mermaid.js CDN is accessible
- Check for extremely large diagram definitions

**Scrolling issues:**
- Verify `overflow-y: auto` in target tab panel
- Check for no fixed heights blocking content
- Ensure 100px bottom padding for taskbar clearance

## Future Enhancements

- Real-time Reltio API integration
- Advanced filtering and search
- Export to CSV/PDF capabilities
- Configuration comparison tools
- Impact analysis visualizations
- Performance metrics dashboard
- Change history tracking

---

**Version**: 1.0.0  
**Last Updated**: April 2026  
**Status**: Production Ready
