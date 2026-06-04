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
  let printNextModel = false;
  for await (const line of rl) {
    const obj = JSON.parse(line);
    step = obj.step_index;
    if (obj.type === 'USER_INPUT') {
      const content = obj.content.toLowerCase();
      if (step >= 520 && step <= 560) {
        console.log(`\n--- STEP ${step} (USER) ---`);
        console.log(obj.content);
        printNextModel = true;
      } else {
        printNextModel = false;
      }
    } else if (obj.source === 'MODEL' && printNextModel) {
      if (obj.content) {
        console.log(`\n--- STEP ${step} (MODEL) ---`);
        console.log(obj.content.slice(0, 1500));
      }
    }
  }
};

main();
