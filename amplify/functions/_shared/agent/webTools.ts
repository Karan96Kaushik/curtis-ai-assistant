import { z } from 'zod';
import webFetchPageTask from '../../../../src/tasks/webFetchPage.js';
import webSearchTask from '../../../../src/tasks/webSearch.js';
import { runLocalTask } from '../../../../src/util/runLocalTask.js';
import type { ToolDef } from './types.js';

type FormattedTask = ((payload: object) => Promise<unknown>) & {
  formatResult: (raw: unknown) => string;
};

function asTask(mod: unknown): FormattedTask {
  return mod as FormattedTask;
}

function task(name: string, execute: FormattedTask): ToolDef['handler'] {
  return async (args) => {
    const out = await runLocalTask(name, execute, execute.formatResult, args);
    return { text: String(out.text ?? '') };
  };
}

/** Web search / fetch via SERP_API_KEY (same tasks as chat). */
export const WEB_TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    integration: 'web',
    access: 'read',
    risk: 'low',
    description:
      'Search the web for a query and return the top results (title, link, snippet). Not for reading a specific URL — use web_fetch_page for that. Do not use for github.com — use github_* tools.',
    schema: z.object({
      query: z.string().min(1).max(500),
    }),
    maxResultChars: 6000,
    handler: task('web-search', asTask(webSearchTask)),
  },
  {
    name: 'web_fetch_page',
    integration: 'web',
    access: 'read',
    risk: 'low',
    description:
      'Open a URL and return readable page text. Prefer github_* for github.com URLs. If little text returns (JS-rendered page), say so.',
    schema: z.object({
      url: z.string().min(1).max(2000),
      max_chars: z.coerce.number().int().min(200).max(50000).optional(),
    }),
    maxResultChars: 12000,
    handler: task('web-fetch-page', asTask(webFetchPageTask)),
  },
];
