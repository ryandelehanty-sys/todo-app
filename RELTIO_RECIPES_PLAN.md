# Reltio Recipes Tab Redesign Plan

## Goals
- Replace Snowflake Recipes tab with "Reltio Recipes"
- Import/export data from a user-selected folder (e.g., C:\Users\delehary\Desktop\MDM APP\Full Manifest)
- Parse and display:
  - List of projects
  - Recipes within each project
  - Visual representation of each recipe's flow (e.g., Mermaid diagram)

## Steps
1. Add file/folder picker to Recipes tab for import
2. Parse Reltio export data (JSON/YAML/CSV as needed)
3. Render project list and expandable recipes
4. For each recipe, show a diagram of the flow (source, transforms, targets)
5. Update UI/UX to match new structure

## Data Model (example)
- Project: { name, recipes: [ ... ] }
- Recipe: { name, steps: [ ... ], sources: [...], targets: [...], transforms: [...] }

## Visualization
- Use Mermaid.js for flowcharts
- Show recipe steps as nodes/edges

## Next Steps
- Implement import function and parser
- Build new Recipes tab UI
- Integrate diagram rendering
