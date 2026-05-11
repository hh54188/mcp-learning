import { genkit } from 'genkit';
import dotenv from 'dotenv';
import { googleAI } from '@genkit-ai/google-genai';
import { createMcpClient } from '@genkit-ai/mcp';

dotenv.config();

const githubClient = createMcpClient({
  name: 'githubClient',
  mcpServer: {
    url: 'https://api.githubcopilot.com/mcp/',
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    },
  },
});

const ai = genkit({
  plugins: [googleAI()],
});

(async () => {
  await githubClient.ready();

  const githubTools = await githubClient.getActiveTools(ai);

  console.log(
    'Available GitHub MCP tools:',
    githubTools.map((t) => t.__action.name)
  );

  // Pass only the tools needed for this task — the full tool list contains
  // tools with malformed JSON schemas that Gemini rejects.
  const neededToolNames = ['get_file_contents', 'search_repositories'];
  const filteredTools = githubTools.filter((t) =>
    neededToolNames.some((name) => t.__action.name.includes(name))
  );

  const { text } = await ai.generate({
    model: googleAI.model('gemini-2.5-flash'),
    tools: filteredTools,
    prompt: 'List all the folders name in the my GitHub repo https://github.com/hh54188/job-crawler root folder',
  });

  console.log('\n=== Agent response ===');
  console.log(text);

  await githubClient.disable();
})();
