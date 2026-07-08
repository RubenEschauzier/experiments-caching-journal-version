import * as fs from 'fs';
import * as path from 'path';

// Configuration
const INPUT_DIR = './generated/out-queries'; 
const OUTPUT_DIR = './generated/out-queries';
const REPEAT_COUNT = 2;

function processSequences() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const files = fs.readdirSync(INPUT_DIR);
  console.log(files)
  const metadataFiles = files.filter((f: string) => f.match(/^sequence_\d+\.metadata\.json$/));
  const uniqueTemplates = new Map<string, { metadata: any, sparql: string }>();

  // 1. Parse existing files and extract unique templates
  metadataFiles.forEach((metaFile: string) => {
    console.log("Metadata")
    const baseName = metaFile.replace('.metadata.json', '');
    const sparqlFile = `${baseName}.sparql`;

    if (!fs.existsSync(path.join(INPUT_DIR, sparqlFile))) {
      console.warn(`Missing SPARQL file for ${baseName}. Skipping.`);
      return;
    }

    const metaContent = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, metaFile), 'utf-8'));
    const sparqlContent = fs.readFileSync(path.join(INPUT_DIR, sparqlFile), 'utf-8');

    // Split SPARQL file by lookahead for 'PREFIX' to keep queries intact
    const queries = sparqlContent
      .split(/\n\s*\n(?=PREFIX)/gi)
      .map((q: string) => q.trim())
      .filter((q: string) => q.length > 0);

    const elements = metaContent.sequenceElements || [];

    if (elements.length !== queries.length) {
      console.warn(`Warning: Mismatch in element/query count for ${baseName}. JSON: ${elements.length}, SPARQL: ${queries.length}.`);
    }

    const minLen = Math.min(elements.length, queries.length);
    for (let i = 0; i < minLen; i++) {
      const el = elements[i];
      const template = el.template;
      
      if (template && !uniqueTemplates.has(template)) {
        uniqueTemplates.set(template, {
          metadata: el,
          sparql: queries[i]
        });
      }
    }
  });

  // Generate new sequence files
  let seqIndex = 0;
  uniqueTemplates.forEach((data, templateName) => {
    const newMetaFileName = `repeat_${templateName}.metadata.json`;
    const newSparqlFileName = `repeat_${templateName}.sparql`;

    const newSequenceElements = Array(REPEAT_COUNT).fill(data.metadata);
    
    // Construct new metadata object, preserving standard structure
    const newMetadata = {
      user: {
        user: "http://solidbench-server:3000/pods/00000000000000000933/profile/card#me",
        transitionProbability: 0.09954255358650524
      },
      sequenceElements: newSequenceElements
    };

    const newSparqlContent = Array(REPEAT_COUNT).fill(data.sparql).join('\n\n');

    fs.writeFileSync(path.join(OUTPUT_DIR, newMetaFileName), JSON.stringify(newMetadata, null, 2));
    fs.writeFileSync(path.join(OUTPUT_DIR, newSparqlFileName), newSparqlContent);

    console.log(`Created sequence for template '${templateName}' -> ${newMetaFileName}`);
    seqIndex++;
  });

  console.log(`\nFinished processing. Created ${seqIndex} new unique sequences.`);
}

processSequences();