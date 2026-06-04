const fs = require('fs');
const readline = require('readline');

const logFile = 'C:\\Users\\david\\.gemini\\antigravity\\brain\\8b7a4931-70eb-42b7-a993-31c538acfdc8\\.system_generated\\logs\\transcript.jsonl';

const main = async () => {
  const fileStream = fs.createReadStream(logFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let step = 0;
  for await (const line of rl) {
    const obj = JSON.parse(line);
    step = obj.step_index;
    if (obj.type === 'USER_INPUT') {
      const content = obj.content.toLowerCase();
      if (content.includes('source') || content.includes('drugbank') || content.includes('drug bank') || content.includes('pubmed') || content.includes('medscape')) {
        console.log(`\n--- STEP ${step} (USER) ---`);
        console.log(obj.content);
      }
    }
  }
};

main();
