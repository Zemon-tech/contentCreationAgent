import { checkXSessionTool, publishToXTool, directNewsToXTool } from '../tools/x-tools';

async function main() {
  console.log('=== Checking X Browser Session ===');
  const session = await checkXSessionTool.execute!({} as any, {} as any);
  console.log('Session Status:', JSON.stringify(session, null, 2));

  console.log('\n=== Testing Dry-Run Direct News Drafting ===');
  const sampleNews =
    'Anthropic announced Claude 3.7 Sonnet with hybrid reasoning capabilities, combining instant responses with step-by-step thinking for code generation.';

  console.log('Crafting draft and testing composition in dry-run mode...');
  const directResult: any = await directNewsToXTool.execute!(
    {
      news: sampleNews,
      headline: 'Anthropic releases Claude 3.7 Sonnet with hybrid reasoning',
      with_graphic: false,
      dry_run: true,
    } as any,
    {} as any,
  );

  console.log('\nResult:');
  console.log('Tweet Text:\n', directResult?.tweetText);
  console.log('Status Message:', directResult?.message);
  if (directResult?.error) {
    console.log('Note:', directResult.error);
  }
}

main().catch(console.error);
