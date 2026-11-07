/**
 * Demo data for local development: two fictional repositories with open issues and the triage
 * suggestions a model might have made for them, so the review UI can be used without GitHub or
 * a model API key. Every issue and suggestion here was written for this project.
 */
import type { Priority } from '@issue-triage/shared';
import { count, inArray } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { issues, repositories, triageSuggestions } from '../db/schema.js';
import type { GitHubLabel } from '../github/client.js';
import { PROMPT_VERSION } from '../triage/prompt.js';

interface DemoSuggestion {
  summary: string;
  labels: [names: string[], confidence: number, rationale: string];
  priority: [level: Priority, confidence: number, rationale: string];
  duplicates?: [
    numbers: { number: number; reason: string }[],
    confidence: number,
    rationale: string,
  ];
}

interface DemoIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels?: string[];
  /** How long ago the issue was opened. */
  hoursAgo: number;
  state?: 'open' | 'closed';
  suggestion?: DemoSuggestion;
}

interface DemoRepository {
  githubId: number;
  owner: string;
  name: string;
  labels: [name: string, color: string, description: string | null][];
  issues: DemoIssue[];
}

const PRIORITY_LABELS: DemoRepository['labels'] = [
  ['priority: urgent', 'b60205', 'Drop everything'],
  ['priority: high', 'd93f0b', 'Next up'],
  ['priority: medium', 'fbca04', null],
  ['priority: low', 'c2e0c6', 'Whenever there is time'],
];

const NO_DUPLICATES: NonNullable<DemoSuggestion['duplicates']> = [
  [],
  0.85,
  'None of the candidates describe the same problem.',
];

export const DEMO_REPOSITORIES: DemoRepository[] = [
  {
    githubId: -1,
    owner: 'lumen-labs',
    name: 'lumen',
    labels: [
      ['bug', 'd73a4a', "Something isn't working"],
      ['regression', 'e11d21', 'Worked in an earlier release'],
      ['enhancement', 'a2eeef', 'New feature or request'],
      ['performance', '5319e7', 'Slow, or uses too much memory'],
      ['documentation', '0075ca', 'Docs are missing or wrong'],
      ['question', 'd876e3', 'Further information is requested'],
      ['needs triage', 'ededed', 'Not looked at yet'],
      ['good first issue', '7057ff', 'Good for newcomers'],
      ['area: dashboards', '1d76db', 'Panels, layout, and variables'],
      ['area: export', '0e8a16', 'PDF and PNG export'],
      ['area: alerts', 'f9d0c4', 'Alert rules and notifications'],
      ['area: auth', 'bfd4f2', 'Sign-in, sessions, and API keys'],
      ...PRIORITY_LABELS,
    ],
    issues: [
      {
        number: 1184,
        title: 'Exporting a dashboard to PDF crashes when a panel has no data',
        body: "Server log shows TypeError reading 'series' of undefined when exporting to PDF.",
        author: 'ines-r',
        hoursAgo: 24 * 40,
        state: 'closed',
      },
      {
        number: 1290,
        title: 'Alert emails arrive twice after a config reload',
        body: 'After `lumen reload`, every alert sends two emails until the server restarts.',
        author: 'dkowalski',
        hoursAgo: 24 * 21,
        state: 'closed',
      },
      {
        number: 1342,
        title: 'Session expires immediately when the clock on the server is behind',
        body: 'Fixed by allowing 60 seconds of clock skew when checking token expiry.',
        author: 'mfaure',
        hoursAgo: 24 * 12,
        state: 'closed',
      },
      {
        number: 1408,
        title: 'Signing in with SSO loops back to the login page on Safari 19',
        body: [
          'Since 4.2.0, signing in through our SAML provider on Safari 19 sends me back to the',
          'login page after the redirect. Chrome and Firefox work.',
          '',
          'The response sets the session cookie with `SameSite=None` but without `Secure` when',
          'Lumen runs behind our TLS-terminating proxy, and Safari drops it.',
          '',
          'Nobody on our team who uses Safari can sign in at all.',
        ].join('\n'),
        author: 'tomasz-w',
        labels: ['needs triage'],
        hoursAgo: 3,
        suggestion: {
          summary:
            'SSO sign-in loops on Safari 19 since 4.2.0: behind a TLS proxy the session cookie is set with SameSite=None but without Secure, so Safari discards it.',
          labels: [
            ['bug', 'regression', 'area: auth'],
            0.92,
            'A sign-in failure that started with 4.2.0, in the session cookie handling.',
          ],
          priority: [
            'urgent',
            0.81,
            'Every Safari user behind a proxy is locked out, with no workaround.',
          ],
          duplicates: [
            [
              {
                number: 1342,
                reason: 'Also a session lost right after sign-in, though caused by clock skew.',
              },
            ],
            0.31,
            'Issue 1342 has the same symptom but a different cause, so it is probably not a duplicate.',
          ],
        },
      },
      {
        number: 1411,
        title: 'PDF export of the "Fleet overview" dashboard fails with a 500',
        body: [
          'Steps:',
          '1. Open the Fleet overview dashboard (it has one empty "Errors" panel this week)',
          '2. Share > Export > PDF',
          '',
          "Expected a PDF. Got a 500, and the server log says `TypeError: Cannot read properties of undefined (reading 'series')`.",
        ].join('\n'),
        author: 'ana-lopes',
        labels: ['needs triage'],
        hoursAgo: 6,
        suggestion: {
          summary:
            'PDF export returns a 500 for a dashboard with an empty panel, with the same TypeError as the export crash fixed earlier.',
          labels: [['bug', 'area: export'], 0.94, 'An export crash with a stack trace.'],
          priority: [
            'high',
            0.72,
            'Export is broken for any dashboard with an empty panel; PNG export still works.',
          ],
          duplicates: [
            [
              {
                number: 1184,
                reason: "Same TypeError reading 'series' when a panel has no data.",
              },
            ],
            0.88,
            'Issue 1184 reports the identical error and trigger; this may be a regression of its fix.',
          ],
        },
      },
      {
        number: 1413,
        title: 'Legend shows <b>raw HTML tags</b> from series names',
        body: [
          'A series named `<b>p99</b> latency` shows the tags literally in the legend instead of',
          'bold text. Not sure whether that is intended; the old renderer used to format it.',
        ].join('\n'),
        author: 'kenji-o',
        labels: ['needs triage'],
        hoursAgo: 9,
        suggestion: {
          summary:
            'Series names containing HTML are shown with literal tags in the legend; the reporter expected them to be rendered as markup.',
          labels: [
            ['question', 'area: dashboards'],
            0.58,
            'Showing names as text is likely deliberate; this reads as a question about intent.',
          ],
          priority: ['low', 0.66, 'Cosmetic, and rendering the HTML would be a security risk.'],
          duplicates: NO_DUPLICATES,
        },
      },
      {
        number: 1415,
        title: 'Alert notifications are sent twice since upgrading to 4.2',
        body: 'Each firing alert now posts two identical messages to Slack. Started after the upgrade; config unchanged.',
        author: 'priya-n',
        labels: ['needs triage'],
        hoursAgo: 14,
        suggestion: {
          summary:
            'Since 4.2, every firing alert posts two identical Slack messages with an unchanged configuration.',
          labels: [
            ['bug', 'regression', 'area: alerts'],
            0.86,
            'Duplicate notifications that began with an upgrade.',
          ],
          priority: ['high', 0.64, 'Noisy for every team using alerts, but nothing is lost.'],
          duplicates: [
            [{ number: 1290, reason: 'Alerts sent twice, there after a config reload.' }],
            0.62,
            'Issue 1290 had the same symptom with a different trigger; worth checking its fix.',
          ],
        },
      },
      {
        number: 1417,
        title: 'Dashboard with 40 panels takes 20 seconds to load',
        body: [
          'Our main dashboard has 40 panels over 12 data sources. In 4.1 it loaded in about',
          '4 seconds; now it takes 20. The browser profile shows most time in layout, with',
          'every panel re-measuring after each query returns.',
        ].join('\n'),
        author: 'olu-a',
        labels: ['needs triage'],
        hoursAgo: 20,
        suggestion: {
          summary:
            'A 40-panel dashboard went from 4 to 20 seconds to load after 4.1; profiling points at repeated layout as each query returns.',
          labels: [
            ['performance', 'regression', 'area: dashboards'],
            0.83,
            'A slowdown since an earlier release, with a profile.',
          ],
          priority: ['medium', 0.55, 'Slow but usable; affects large dashboards.'],
          duplicates: NO_DUPLICATES,
        },
      },
      {
        number: 1419,
        title: 'Document how to rotate API keys without downtime',
        body: 'The docs explain creating and deleting API keys, but not how to swap one in production without a gap.',
        author: 'rmoreau',
        labels: ['needs triage'],
        hoursAgo: 26,
        suggestion: {
          summary: 'Asks for documentation on rotating API keys in production without an outage.',
          labels: [
            ['documentation', 'area: auth', 'good first issue'],
            0.9,
            'A docs gap with a clear scope.',
          ],
          priority: ['low', 0.78, 'Useful, not blocking anyone.'],
          duplicates: NO_DUPLICATES,
        },
      },
      {
        number: 1420,
        title: 'Allow dashboard variables to depend on other variables',
        body: 'We want a "cluster" variable whose options depend on the selected "region". Today each variable is independent.',
        author: 'sv-chen',
        labels: ['needs triage'],
        hoursAgo: 30,
        suggestion: {
          summary:
            'Feature request: chained dashboard variables, where options depend on another variable.',
          labels: [['enhancement', 'area: dashboards'], 0.88, 'A new capability for variables.'],
          priority: ['low', 0.6, 'A feature request; no one is blocked.'],
          duplicates: NO_DUPLICATES,
        },
      },
      {
        number: 1422,
        title: 'Times in the alert history are off by one hour',
        body: 'Alert history shows times one hour behind the panels. Our browser and server are both on Europe/Lisbon. Possibly DST related?',
        author: 'joao-p',
        labels: ['needs triage'],
        hoursAgo: 44,
        suggestion: {
          summary:
            'Alert history timestamps are one hour behind the panels for a Europe/Lisbon setup, possibly a daylight saving time issue.',
          labels: [
            ['bug', 'area: alerts'],
            0.47,
            'Probably a time zone bug, but it could be configuration.',
          ],
          priority: [
            'medium',
            0.42,
            'Misleading during incidents, but the underlying data is correct.',
          ],
          duplicates: NO_DUPLICATES,
        },
      },
    ],
  },
  {
    githubId: -2,
    owner: 'lumen-labs',
    name: 'lumen-agent',
    labels: [
      ['bug', 'd73a4a', "Something isn't working"],
      ['enhancement', 'a2eeef', 'New feature or request'],
      ['needs triage', 'ededed', 'Not looked at yet'],
      ['platform: windows', '0052cc', null],
      ['platform: linux', '006b75', null],
      ['memory', '5319e7', 'Memory use and leaks'],
      ['security', 'b60205', 'Security-relevant'],
      ...PRIORITY_LABELS,
    ],
    issues: [
      {
        number: 212,
        title: 'Agent memory grows by ~50 MB a day on Windows Server',
        body: [
          'lumen-agent 2.8.1 on Windows Server 2025 starts at 60 MB and grows steadily, about',
          '50 MB a day, until we restart it. Linux hosts with the same config stay flat.',
        ].join('\n'),
        author: 'h-bergstrom',
        labels: ['needs triage'],
        hoursAgo: 5,
        suggestion: {
          summary:
            'On Windows Server, agent 2.8.1 leaks about 50 MB a day; Linux hosts with the same configuration do not.',
          labels: [['bug', 'memory', 'platform: windows'], 0.89, 'A Windows-only memory leak.'],
          priority: ['high', 0.7, 'Forces periodic restarts on every Windows host.'],
          duplicates: NO_DUPLICATES,
        },
      },
      {
        number: 214,
        title: 'Config file with an API key is world-readable after install',
        body: 'The Linux package installs /etc/lumen-agent/agent.yaml as 0644, and that file holds the API key.',
        author: 'secops-maria',
        labels: ['needs triage'],
        hoursAgo: 8,
        suggestion: {
          summary:
            'The Linux package installs the agent config, which contains the API key, readable by every user (mode 0644).',
          labels: [
            ['bug', 'security', 'platform: linux'],
            0.95,
            'A secret exposed by file permissions.',
          ],
          priority: ['urgent', 0.84, 'Any local user can read the API key.'],
          duplicates: NO_DUPLICATES,
        },
      },
      {
        number: 215,
        title: 'Support sending metrics through an HTTP proxy',
        body: 'Our hosts can only reach the internet through a proxy. The agent ignores HTTPS_PROXY.',
        author: 'nkariuki',
        labels: ['needs triage'],
        hoursAgo: 50,
        suggestion: {
          summary:
            'Feature request: honour HTTPS_PROXY so the agent works on hosts behind a proxy.',
          labels: [['enhancement'], 0.8, 'New networking capability.'],
          priority: ['medium', 0.5, 'Blocks adoption in locked-down networks, with no workaround.'],
          duplicates: NO_DUPLICATES,
        },
      },
    ],
  },
];

/** Which label stands for each priority in the demo repositories. */
export const DEMO_PRIORITY_LABELS = {
  urgent: 'priority: urgent',
  high: 'priority: high',
  medium: 'priority: medium',
  low: 'priority: low',
} as const satisfies Record<Priority, string>;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Loads the demo repositories, replacing any earlier copy of them (with their reviews and
 * jobs). Other repositories are left alone.
 */
export async function seedDemoData(db: Database, now: Date = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(repositories).where(
      inArray(
        repositories.githubId,
        DEMO_REPOSITORIES.map((repository) => repository.githubId),
      ),
    );

    // Negative GitHub ids can never belong to a real repository or issue, so demo rows can't
    // collide with (or, on reseed, delete) real ones in the same database.
    let issueGithubId = -1000;
    const pending: { issue: DemoIssue; issueId: number; idByNumber: Map<number, number> }[] = [];
    for (const demo of DEMO_REPOSITORIES) {
      const labels: GitHubLabel[] = demo.labels.map(([name, color, description]) => ({
        name,
        color,
        description,
      }));
      const [repository] = await tx
        .insert(repositories)
        .values({
          githubId: demo.githubId,
          owner: demo.owner,
          name: demo.name,
          fullName: `${demo.owner}/${demo.name}`,
          private: false,
          labels,
          labelsFetchedAt: now,
        })
        .returning({ id: repositories.id });
      if (!repository) {
        throw new Error(`Insert returned no repository for ${demo.name}`);
      }

      const idByNumber = new Map<number, number>();
      for (const issue of demo.issues) {
        issueGithubId -= 1;
        const openedAt = new Date(now.getTime() - issue.hoursAgo * HOUR_MS);
        const [row] = await tx
          .insert(issues)
          .values({
            repositoryId: repository.id,
            githubId: issueGithubId,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state ?? 'open',
            labels: issue.labels ?? [],
            authorLogin: issue.author,
            htmlUrl: `https://github.com/${demo.owner}/${demo.name}/issues/${issue.number}`,
            githubCreatedAt: openedAt,
            githubUpdatedAt: openedAt,
            closedAt: issue.state === 'closed' ? openedAt : null,
          })
          .returning({ id: issues.id });
        if (!row) {
          throw new Error(`Insert returned no issue for ${demo.name}#${issue.number}`);
        }
        idByNumber.set(issue.number, row.id);
      }

      for (const issue of demo.issues) {
        const issueId = idByNumber.get(issue.number);
        if (issue.suggestion && issueId !== undefined) {
          pending.push({ issue, issueId, idByNumber });
        }
      }
    }

    // Oldest issue first, across repositories, so the queue's "oldest first" order within a
    // priority matches the issues' ages.
    pending.sort((a, b) => b.issue.hoursAgo - a.issue.hoursAgo);
    for (const { issue, issueId, idByNumber } of pending) {
      const suggestion = issue.suggestion;
      if (!suggestion) {
        continue;
      }
      const [labelNames, labelsConfidence, labelsRationale] = suggestion.labels;
      const [level, priorityConfidence, priorityRationale] = suggestion.priority;
      const [duplicates, duplicatesConfidence, duplicatesRationale] =
        suggestion.duplicates ?? NO_DUPLICATES;
      await tx.insert(triageSuggestions).values({
        issueId,
        summary: suggestion.summary,
        labels: labelNames,
        labelsConfidence,
        labelsRationale,
        priority: level,
        priorityConfidence,
        priorityRationale,
        duplicates: duplicates.flatMap(({ number, reason }) => {
          const duplicateId = idByNumber.get(number);
          return duplicateId === undefined ? [] : [{ issueId: duplicateId, reason }];
        }),
        duplicatesConfidence,
        duplicatesRationale,
        model: 'demo-data',
        promptVersion: PROMPT_VERSION,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        modelCalls: 1,
        latencyMs: 0,
      });
    }
  });
}

/** Loads the demo data only into a database without any repositories. Returns whether it did. */
export async function seedDemoDataIfEmpty(db: Database): Promise<boolean> {
  const [existing] = await db.select({ repositories: count() }).from(repositories);
  if ((existing?.repositories ?? 0) > 0) {
    return false;
  }
  await seedDemoData(db);
  return true;
}
