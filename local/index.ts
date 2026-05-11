import { genkit } from 'genkit';
import dotenv from 'dotenv'
import { googleAI } from '@genkit-ai/google-genai';
import { createMcpClient } from '@genkit-ai/mcp';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filesDir = path.join(__dirname, 'files');

const myFsClient = createMcpClient({
  name: 'myFileSystemClient',
  mcpServer: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  },
  // rawToolResponses: true, 
});

// In your Genkit configuration:
const ai = genkit({
  plugins: [googleAI()],
});

(async () => {
  await myFsClient.ready();

  const fsTools = await myFsClient.getActiveTools(ai);

  const { text } = await ai.generate({
    model: googleAI.model('gemini-2.5-flash'), // Replace with your model
    prompt: 'List files in ' + process.cwd(),
    tools: fsTools,
  });
  console.log(text);

  await myFsClient.disable();
})();
