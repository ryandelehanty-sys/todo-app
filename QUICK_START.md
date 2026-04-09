# Quick Start Guide - Reltio MDM Configuration Parser

## Access Your Dashboard

**URL:** `http://localhost:5500`

The server is already running. Simply open this URL in your browser.

---

## What You Can Do Now

### 1. View Sample Configuration
- Dashboard loads with sample configuration automatically
- Shows 5 entity types: Individual, Organization, Location, Product, Supplier
- Displays 8 data sources and 4 relationships
- Demonstrates complete parser functionality

### 2. Upload Your Own Configuration
1. Click **"Upload Configuration"** button in the header
2. Select your Reltio configuration JSON file (e.g., `77MYBPkMSfSMdSk_L3_configuration.json`)
3. Dashboard updates automatically with your data

### 3. Explore Six Dashboard Tabs

#### **Architecture Map**
- Visual entity-to-source diagram
- Metrics: entities, attributes, relationships, sources
- Entity type grouping
- Configuration file inventory

#### **Entity Browser**
- Complete list of entity types
- Filter by entity group
- View attributes, relationships, survivorship groups
- Click any entity for detailed information including:
  - Full attribute list with types
  - Multi-value indicators
  - Survivorship and match group counts

#### **Survivorship Strategies**
- All defined survivorship rules
- Source type preferences
- Strategy descriptions
- Click to view strategy details

#### **Data Sources**
- All configured source systems
- Abbreviations and priorities
- Descriptions and URI references
- Source-specific metadata

#### **Integration Registry**
- Complete relationship type catalog
- Start/end entity types
- Direction (directed/bidirectional)
- Relationship attributes
- URI traceability

#### **Lineage Explorer**
- End-to-end data flow visualization
- Multi-hop lineage tracking from sources to downstream
- Configuration impact summary
- Statistics on all configuration elements

---

## Parser Capabilities

The configuration parser automatically:

✓ **Parses Entity Types**
- Extracts all entity definitions
- Counts attributes (including nested)
- Identifies survivorship groups
- Flags abstract vs. concrete entities

✓ **Handles Nested Attributes**
- Recursively processes attribute hierarchies
- Tracks nesting depth
- Shows multi-value attributes
- Maintains parent-child relationships

✓ **Detects Data Sources**
- Lists all source systems
- Shows abbreviations and priorities
- Preserves source descriptions
- Maintains URI references

✓ **Maps Relationships**
- Extracts all relationship types
- Shows start/end entity connections
- Indicates direction (directed/bidirectional)
- Counts relationship attributes

✓ **Identifies Graph Types**
- Detects all graph definitions
- Shows layout types
- Preserves graph structures

✓ **Extracts Survivorship Strategies**
- Lists all strategy types
- Shows winner source preferences
- Supports custom strategies

---

## Supported Configuration Format

Your Reltio configuration JSON must include:

```json
{
  "uri": "configuration",
  "label": "Configuration Name",
  "sources": [
    {
      "uri": "configuration/sources/SystemName",
      "label": "Display Name",
      "abbreviation": "SYS"
    }
  ],
  "entityTypes": [
    {
      "uri": "configuration/entityTypes/EntityName",
      "label": "Entity Label",
      "attributes": [...],
      "survivorshipGroups": [...],
      "matchGroups": [...]
    }
  ],
  "relationTypes": [
    {
      "uri": "configuration/relationTypes/RelName",
      "label": "Relationship Label",
      "startObject": { "objectTypeURI": "..." },
      "endObject": { "objectTypeURI": "..." },
      "direction": "directed"
    }
  ],
  "graphTypes": [...],
  "survivorshipStrategies": [...]
}
```

---

## Key Features

### Real-Time Parsing
- No server-side processing needed
- All parsing happens in browser
- Instant feedback and error messages

### Nested Attribute Support
- Handles multi-level attribute nesting
- Shows depth indicators
- Displays multi-value flags

### Complete Coverage
- All Reltio configuration elements supported
- Preserves all metadata and URIs
- Maintains relationships and hierarchies

### Professional UI
- Enterprise dark theme
- Responsive tab interface
- Detailed information panels
- Automatic diagrams with Mermaid.js

---

## Testing the Parser

**Open browser developer console (F12)** and run:

```javascript
testReltioParser()
```

This will verify all parser functionality and show:
- Entity extraction results
- Attribute parsing (including nested)
- Source system detection
- Relationship counting
- Graph type identification
- Survivorship strategy extraction

---

## Troubleshooting

**Config won't upload?**
- Check JSON syntax: Use a JSON validator tool
- Verify file has all required fields
- Check browser console for error messages

**Diagrams not showing?**
- Verify Mermaid.js CDN is accessible
- Check for very large configuration (1000+ items)
- Try different browser

**Data not updating?**
- Click "Load Sample" to verify parser is working
- Try uploading a smaller test configuration first
- Check browser console for errors

---

## Files in Your Project

- **index.html** - Main dashboard UI with 6 tabs
- **app.js** - Parser + rendering logic (750+ lines)
- **styles.css** - Professional dark theme (~1000 lines)
- **sample-config.json** - Sample Reltio configuration
- **test.js** - Parser verification tests
- **server.ps1** - Local HTTP server
- **README.md** - Complete documentation
- **IMPLEMENTATION_NOTES.md** - Technical implementation details

---

## Example Workflow

1. **Get your Reltio configuration**
   - Export from Reltio admin interface
   - Save as JSON file

2. **Open dashboard**
   - Go to `http://localhost:5500`

3. **Upload configuration**
   - Click "Upload Configuration"
   - Select your JSON file
   - Wait for dashboard to update

4. **Explore your MDM model**
   - Browse entities and attributes
   - View relationships and data sources
   - Analyze lineage and survivorship rules
   - Export insights as needed

---

## Next Steps

- **Customize**: Modify CSS variables in `styles.css` for your color scheme
- **Extend**: Add new tabs or visualization features
- **Integrate**: Connect to real Reltio APIs for live data
- **Export**: Implement CSV/PDF export functionality

---

## Support

- See **README.md** for detailed documentation
- See **IMPLEMENTATION_NOTES.md** for technical details
- Check **test.js** for parser test examples
- Browser console shows detailed error messages

---

**Status**: ✅ Ready to use
**Version**: 1.0.0
**Last Updated**: April 2026
