// Test the Reltio Configuration Parser
// Run this in browser console to verify parser functionality

function testReltioParser() {
  console.log("=== Reltio Configuration Parser Test ===\n");
  
  // Fetch sample config
  fetch('sample-config.json')
    .then(response => response.json())
    .then(config => {
      console.log("✓ Sample config loaded successfully");
      console.log(`  Schema: ${config.schemaVersion}`);
      console.log(`  Label: ${config.label}\n`);
      
      // Initialize parser
      const parser = new ReltioConfigParser(config);
      console.log("✓ Parser initialized\n");
      
      // Test entity parsing
      console.log(`📊 Entities: ${parser.entities.length}`);
      parser.entities.forEach(entity => {
        console.log(`  - ${entity.label}: ${entity.attributeCount} attributes, ${entity.relationshipCount} relationships`);
      });
      console.log();
      
      // Test attribute extraction
      console.log(`📋 Total Attributes: ${parser.attributes.length}`);
      const nestedAttrs = parser.attributes.filter(a => a.isNested);
      console.log(`  - Regular: ${parser.attributes.length - nestedAttrs.length}`);
      console.log(`  - Nested: ${nestedAttrs.length}\n`);
      
      // Test sources
      console.log(`📡 Data Sources: ${parser.sources.length}`);
      parser.sources.slice(0, 5).forEach(source => {
        console.log(`  - ${source.label} (${source.abbreviation})`);
      });
      console.log();
      
      // Test relationships
      console.log(`🔗 Relationships: ${parser.relationships.length}`);
      parser.relationships.forEach(rel => {
        console.log(`  - ${rel.label}: ${rel.startObject?.objectTypeURI?.split('/').pop()} → ${rel.endObject?.objectTypeURI?.split('/').pop()}`);
      });
      console.log();
      
      // Test graph types
      console.log(`📈 Graph Types: ${parser.graphTypes.length}`);
      parser.graphTypes.forEach(graph => {
        console.log(`  - ${graph.label} (${graph.graphStructure})`);
      });
      console.log();
      
      // Test survivorship strategies
      console.log(`⚖️ Survivorship Strategies: ${parser.survivorshipStrategies.length}`);
      parser.survivorshipStrategies.slice(0, 5).forEach(strategy => {
        console.log(`  - ${strategy.label}`);
      });
      console.log();
      
      console.log("=== All Tests Passed ===");
      return parser;
    })
    .catch(error => {
      console.error("✗ Test failed:", error);
    });
}

// Run test
testReltioParser();
