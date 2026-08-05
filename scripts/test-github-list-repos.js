#!/usr/bin/env node
/**
 * Integration smoke test: list every repo accessible via GITHUB_TOKEN.
 *
 * Uses GET /user/repos with affiliation=owner,collaborator,organization_member
 * and paginates until exhausted.
 *
 * Run: npm run test:github-list-repos
 */

require('dotenv').config();

const assert = require('node:assert/strict');
const { createGithubClient } = require('../src/integrations/githubClient');

const PER_PAGE = 100;

async function listAllAccessibleRepos(github) {
  const repos = [];
  let page = 1;

  for (;;) {
    const batch = await github.listRepos({
      type: 'all',
      per_page: PER_PAGE,
      page,
      sort: 'full_name',
    });
    assert.ok(Array.isArray(batch), `page ${page}: expected an array`);
    repos.push(...batch);
    if (batch.length < PER_PAGE) break;
    page += 1;
  }

  return repos;
}

async function main() {
  assert.ok(process.env.GITHUB_TOKEN, 'Missing GITHUB_TOKEN in .env');

  const github = createGithubClient();
  const me = await github.getAuthenticatedUser();
  assert.ok(me?.login, 'Expected authenticated user login');

  const repos = await listAllAccessibleRepos(github);
  assert.ok(Array.isArray(repos), 'Expected repos array');

  const names = repos.map((r) => r.full_name).filter(Boolean);
  assert.equal(names.length, repos.length, 'Every repo should have full_name');

  const unique = new Set(names);
  assert.equal(unique.size, names.length, 'Repo full_names should be unique across pages');

  console.log(`OK  authenticated as ${me.login}`);
  console.log(`OK  accessible repos: ${repos.length}`);
  for (const r of repos) {
    const vis = r.private ? 'private' : 'public';
    console.log(`  • ${r.full_name} [${vis}]`);
  }
}

main().catch((err) => {
  console.error('FAIL', err.message || err);
  process.exitCode = 1;
});
