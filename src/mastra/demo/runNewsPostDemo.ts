import fs from 'node:fs';
import path from 'node:path';

// Ensure .env is loaded in standalone CLI runs
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

import { newsToPostWorkflow } from '../workflows/newsToPostWorkflow';

async function main() {
  let topic = '';
  let format: 'single' | 'carousel' = 'single';
  let template = 'tech-announcement';

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--format' || arg === '-f') {
      format = (args[++i] as any) || 'single';
    } else if (arg === '--template' || arg === '-t') {
      template = args[++i] || 'tech-announcement';
    } else if (!arg.startsWith('-')) {
      topic = topic ? `${topic} ${arg}` : arg;
    }
  }

  if (!topic) {
    topic = 'Artificial Intelligence breakthroughs';
  }

  console.log('==================================================');
  console.log('        News-to-Post Pipeline CLI Demo');
  console.log(`    Topic    : ${topic}`);
  console.log(`    Format   : ${format}`);
  console.log(`    Template : ${template}`);
  console.log('==================================================\n');

  const run = await newsToPostWorkflow.createRun();
  const result = await run.start({
    inputData: {
      topic,
      format,
      template_id: template as any,
      aspect_ratio: '4:5',
      max_slides: 5,
    },
  });

  if (result.status !== 'success') {
    console.error('Workflow failed:', result);
    process.exit(1);
  }

  const out = result.result;
  console.log('\n[SUCCESS] Post deliverables created!');
  console.log(`Job ID        : ${out.job_id}`);
  console.log(`News Title    : ${out.newsTitle}`);
  console.log(`Source URL    : ${out.newsUrl}`);
  console.log(`Workspace Dir : ${out.workspaceDir}`);
  console.log(`Slides        : ${out.slides.length} slide(s) produced`);
  out.slides.forEach((s) => console.log(`  * Slide ${s.index + 1}: ${s.file} (${s.alt_text})`));
  console.log(`\nCaption:\n${out.caption}`);
  console.log(`\nHashtags:\n${out.hashtags.map((h) => '#' + h).join(' ')}`);
  console.log(`\nWorkspace files copied:`);
  out.copiedFiles.forEach((f) => console.log(`  - ${f}`));
}

main().catch((err) => {
  console.error('Error executing news-to-post pipeline:', err);
  process.exit(1);
});
