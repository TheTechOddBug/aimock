import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  ADOPTER_DISPLAY,
  EXCLUDED_ADOPTERS,
  MIN_WALL_SIZE,
  STAR_FLOOR,
  EXIT_CLEAN,
  EXIT_CHANGED_SAFE,
  EXIT_NEEDS_REVIEW,
  avatarUrl,
  checkLogo,
  checkLogos,
  classify,
  decodeHtml,
  escapeHtml,
  exitCodeFor,
  buildRepoMetaQuery,
  buildSummary,
  clearsWallFilters,
  fetchRepoMetaGraphQL,
  loadAdopterState,
  parseAdopterState,
  marqueeDuration,
  monogramLetter,
  MARQUEE_SECONDS_PER_TILE,
  MARQUEE_MIN_SECONDS,
  STATE_BRANCH,
  STATE_FILE,
  excludeReason,
  explainDrop,
  forkDisagreements,
  metaFor,
  partitionDrops,
  missingFromState,
  orgRunnersUp,
  parseMetaFile,
  parseWall,
  probeTargets,
  rankCandidates,
  resolutionLine,
  fetchRepoMetaRest,
  renderWall,
  replaceRegion,
  resolveDisplay,
  orgOf,
  safeUrl,
  selectAdopters,
  topCandidate,
  type AdopterState,
  type CheckResult,
  type RepoMeta,
  type WallEntry,
} from "../../scripts/update-adoption-wall.js";

const meta = (stars: number, ownerId = 1, isFork = false): RepoMeta => ({ stars, ownerId, isFork });
/** A star count comfortably clear of STAR_FLOOR, so the floor never confounds a case. */
const OK_STARS = STAR_FLOOR * 10;
/** Shorthand for "the GitHub API says this one really is a fork." */
const forkMeta = (stars: number, ownerId = 1): RepoMeta => meta(stars, ownerId, true);

function metaMap(entries: Record<string, RepoMeta>): Map<string, RepoMeta> {
  return new Map(Object.entries(entries));
}

function ok(repo: string, url = "u"): CheckResult {
  return { url, repo, ok: true, status: 200, kind: "ok", detail: "HTTP 200" };
}

function dead(repo: string, url = "u"): CheckResult {
  return { url, repo, ok: false, status: 404, kind: "http", detail: "HTTP 404" };
}

function inconclusive(repo: string, url = "u"): CheckResult {
  return { url, repo, ok: false, status: null, kind: "inconclusive", detail: "timed out" };
}

/**
 * The exclude-list entry those tests below are ABOUT. Named, not
 * `EXCLUDED_SUBJECT`: picking by position silently re-points
 * every assertion the day somebody adds an alphabetically-earlier entry, so the
 * tests would keep passing while testing a different repo than they claim to.
 */
const EXCLUDED_SUBJECT = "tylaujjapan0/openclaw";

const PAGE = `<div>\n  <!-- adoption-wall:start -->\n  <!-- old -->\n  <!-- adoption-wall:end -->\n</div>\n`;

describe("escaping", () => {
  it("escapes every HTML metacharacter", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  it("round-trips through decodeHtml", () => {
    const raw = `Acme & Co "<b>" 'x'`;
    expect(decodeHtml(escapeHtml(raw))).toBe(raw);
  });

  it("decodes &amp; so the health check probes the URL the browser requests", () => {
    expect(decodeHtml("https://x/u/1?s=128&amp;v=4")).toBe("https://x/u/1?s=128&v=4");
  });
});

describe("safeUrl", () => {
  it("keeps http and https", () => {
    expect(safeUrl("https://a.example", "fb")).toBe("https://a.example");
    expect(safeUrl("http://a.example", "fb")).toBe("http://a.example");
  });

  it("rejects javascript: and other non-http schemes", () => {
    expect(safeUrl("javascript:alert(1)", "fb")).toBe("fb");
    expect(safeUrl("data:text/html,<script>", "fb")).toBe("fb");
    expect(safeUrl("not a url", "fb")).toBe("fb");
  });
});

describe("resolveDisplay", () => {
  it("uses the mapping when present", () => {
    expect(resolveDisplay("mastra-ai/mastra")).toEqual({
      name: "Mastra",
      url: "https://mastra.ai",
      mapped: true,
      chip: false,
      monogram: false,
    });
  });

  it("falls back to the org login and repo URL, flagged unmapped", () => {
    expect(resolveDisplay("someorg/somerepo")).toEqual({
      name: "someorg",
      url: "https://github.com/someorg/somerepo",
      mapped: false,
      chip: false,
      monogram: false,
    });
  });

  // Regression guard for a wall that shipped eight tiles reading `rivet-dev`,
  // `atomicstrata`, `cortexkit`, `openstory-so`, `SkillNerds`, `selfagency`,
  // `cacheplane`, `ysansan98` -- raw GitHub logins sitting next to Mattermost and
  // Deepnote. Every repo that renders must have a human display name.
  it("has a display entry for every repo that was showing a bare GitHub login", () => {
    for (const repo of [
      "atomicstrata/llm-wiki-compiler",
      "cacheplane/angular-agent-framework",
      "cortexkit/magic-context",
      "openstory-so/openstory",
      "selfagency/opilot",
      "SkillNerds/xskill",
      "ysansan98/ant-chat",
    ]) {
      expect(resolveDisplay(repo).mapped, repo).toBe(true);
    }
  });

  // Two of those have no website at all -- cortexkit declares a Discord invite,
  // ant-chat declares nothing. Pointing at the repo is honest; the point of the
  // entry is the NAME.
  it("names a repo even when no homepage exists, falling back to the repo URL", () => {
    for (const repo of ["cortexkit/magic-context", "ysansan98/ant-chat"]) {
      const d = resolveDisplay(repo);
      expect(d.mapped, repo).toBe(true);
      expect(d.url, repo).toBe(`https://github.com/${repo}`);
      expect(d.name, repo).not.toBe(orgOf(repo));
    }
  });

  it("every mapped homepage is an http(s) URL", () => {
    for (const [repo, entry] of Object.entries(ADOPTER_DISPLAY)) {
      expect(safeUrl(entry.url, "REJECTED"), repo).not.toBe("REJECTED");
    }
  });
});

describe("selectAdopters", () => {
  const adopters: AdopterState[] = [
    { repo: "a/one", isFork: false, missedRuns: 0 },
    { repo: "b/two", isFork: false, missedRuns: 0 },
    { repo: "c/three", isFork: false, missedRuns: 2 },
    { repo: "d/four", isFork: false, missedRuns: 0 },
  ];
  const m = metaMap({
    "a/one": meta(OK_STARS),
    "b/two": forkMeta(9999),
    "c/three": meta(8888),
    "d/four": meta(OK_STARS * 2),
  });

  it("drops forks and adopters missing from the latest scan", () => {
    expect(selectAdopters(adopters, m).map((e) => e.repo)).toEqual(["d/four", "a/one"]);
  });

  it("ranks by stars descending", () => {
    expect(selectAdopters(adopters, m).map((e) => e.stars)).toEqual([OK_STARS * 2, OK_STARS]);
  });

  // THE REGRESSION. The state file marked openclaw/openclaw (388k stars) and
  // Zoo-Code-Org/Zoo-Code as forks; the GitHub API says fork: false with no
  // parent for both. Believing the file deleted the flagship adopter from a
  // public page. Fork status comes from the API record, full stop.
  it("ignores the state file's isFork and believes the API", () => {
    const mislabelled: AdopterState[] = [
      { repo: "openclaw/openclaw", isFork: true, missedRuns: 0 },
      { repo: "small/repo", isFork: false, missedRuns: 0 },
    ];
    const mm = metaMap({
      "openclaw/openclaw": meta(388275, 99),
      "small/repo": meta(OK_STARS, 100),
    });
    expect(selectAdopters(mislabelled, mm).map((e) => e.repo)).toEqual([
      "openclaw/openclaw",
      "small/repo",
    ]);
  });

  it("still drops a repo the API itself calls a fork, whatever the file says", () => {
    const claimed: AdopterState[] = [{ repo: "someone/fork-of-x", isFork: false, missedRuns: 0 }];
    const mm = metaMap({ "someone/fork-of-x": forkMeta(9999) });
    expect(selectAdopters(claimed, mm)).toEqual([]);
  });

  it("breaks ties on repo name so output is stable run to run", () => {
    const tied: AdopterState[] = [
      { repo: "z/z", isFork: false, missedRuns: 0 },
      { repo: "a/a", isFork: false, missedRuns: 0 },
    ];
    const tm = metaMap({ "z/z": meta(OK_STARS), "a/a": meta(OK_STARS) });
    expect(selectAdopters(tied, tm).map((e) => e.repo)).toEqual(["a/a", "z/z"]);
    // Reversed input must produce the same order.
    expect(selectAdopters([...tied].reverse(), tm).map((e) => e.repo)).toEqual(["a/a", "z/z"]);
  });

  // Uncapped on purpose: a cap makes every new adopter an eviction, an eviction
  // trips the disappearance guardrail, and the wall could then never auto-land.
  it("renders every qualifying adopter with no top-N cut", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      repo: `org${String(i).padStart(2, "0")}/r`,
      isFork: false,
      missedRuns: 0,
    }));
    const mm = metaMap(Object.fromEntries(many.map((a, i) => [a.repo, meta(1000 - i, i)])));
    expect(selectAdopters(many, mm)).toHaveLength(40);
  });

  it("skips adopters with no resolved repo metadata", () => {
    expect(
      selectAdopters(adopters, metaMap({ "a/one": meta(OK_STARS) })).map((e) => e.repo),
    ).toEqual(["a/one"]);
  });
});

describe("star floor", () => {
  it("is 40, and Deepnote at 45 survives it", () => {
    // 50 was the obvious round number, but deepnote/vscode-deepnote sits at 45 and
    // the star count measures a VS Code extension, not the company. Do not tidy
    // this constant up to 50.
    expect(STAR_FLOOR).toBe(40);
    expect(45).toBeGreaterThanOrEqual(STAR_FLOOR);
    const adopters: AdopterState[] = [{ repo: "deepnote/vscode-deepnote", missedRuns: 0 }];
    const m = metaMap({ "deepnote/vscode-deepnote": meta(45, 7) });
    expect(selectAdopters(adopters, m).map((e) => e.repo)).toEqual(["deepnote/vscode-deepnote"]);
  });

  it("drops anything below the floor", () => {
    const adopters: AdopterState[] = [
      { repo: "at/floor", missedRuns: 0 },
      { repo: "below/floor", missedRuns: 0 },
    ];
    const m = metaMap({
      "at/floor": meta(STAR_FLOOR, 1),
      "below/floor": meta(STAR_FLOOR - 1, 2),
    });
    expect(selectAdopters(adopters, m).map((e) => e.repo)).toEqual(["at/floor"]);
  });
});

describe("exclude list", () => {
  it("suppresses a listed repo even when it clears the floor", () => {
    const repo = EXCLUDED_SUBJECT;
    const adopters: AdopterState[] = [
      { repo, missedRuns: 0 },
      { repo: "keep/me", missedRuns: 0 },
    ];
    const m = metaMap({ [repo]: meta(99999, 1), "keep/me": meta(OK_STARS, 2) });
    expect(selectAdopters(adopters, m).map((e) => e.repo)).toEqual(["keep/me"]);
  });

  it("matches case-insensitively, so casing drift cannot bypass it", () => {
    const repo = EXCLUDED_SUBJECT;
    expect(excludeReason(repo.toUpperCase())).not.toBeNull();
    expect(excludeReason("nobody/here")).toBeNull();
  });

  it("every entry carries a reason stating the evidence, not just a verdict", () => {
    for (const [repo, reason] of Object.entries(EXCLUDED_ADOPTERS)) {
      expect(reason.length, repo).toBeGreaterThan(40);
    }
  });

  // The judgement call this list encodes: openclaw derivatives are excluded on
  // evidence, never on a name substring -- openclaw/openclaw is the single
  // biggest legitimate adopter and must never be caught by its own name.
  it("does not exclude openclaw/openclaw itself", () => {
    expect(excludeReason("openclaw/openclaw")).toBeNull();
    for (const repo of Object.keys(EXCLUDED_ADOPTERS)) {
      expect(repo).not.toBe("openclaw/openclaw");
    }
  });

  it("reports what it suppressed in the summary, and says so even at zero", () => {
    const md = buildSummary({
      status: "SAFE",
      reasons: [],
      current: [],
      next: [],
      checks: [],
      verifyOnly: false,
      suppressed: [],
    });
    expect(md).toMatch(/Exclude list: \d+ entr\(y\/ies\), suppressed \*\*0\*\* repo\(s\)/);
  });
});

describe("deliberate removals are not disappearances", () => {
  const tile = (repo: string) => ({ repo, name: repo, url: "u", logo: "l" });

  it("a repo falling below the star floor is explained, not alarming", () => {
    const m = metaMap({ "fading/repo": meta(STAR_FLOOR - 1, 1) });
    const note = explainDrop("fading/repo", m);
    expect(note?.kind).toBe("star-floor");
    expect(note?.stars).toBe(STAR_FLOOR - 1);
    expect(note?.detail).toContain(`below the ${STAR_FLOOR}-star floor`);
  });

  it("a repo added to the exclude list is explained, not alarming", () => {
    const repo = EXCLUDED_SUBJECT;
    const note = explainDrop(repo, metaMap({ [repo]: meta(99999, 1) }));
    expect(note?.kind).toBe("exclude-list");
    expect(note?.detail).toBe(EXCLUDED_ADOPTERS[repo]);
  });

  // A repo the scan stopped seeing, or one newly called a fork, stays alarming:
  // that is the silent-deletion case the whole file exists to catch.
  it("a repo that simply vanished from the scan is NOT explained", () => {
    expect(explainDrop("gone/away", metaMap({}))).toBeNull();
  });

  it("a repo newly classified a fork is NOT explained", () => {
    expect(explainDrop("now/fork", metaMap({ "now/fork": forkMeta(99999, 1) }))).toBeNull();
  });

  it("partitions today's tiles into explained and unexplained drops", () => {
    const current = [tile("stays/put"), tile("fading/repo"), tile("gone/away")];
    const next = [{ repo: "stays/put" } as WallEntry];
    const m = metaMap({ "stays/put": meta(OK_STARS, 1), "fading/repo": meta(1, 2) });
    const { explained, unexplained } = partitionDrops(current, next, m);
    expect(explained).toHaveLength(1);
    expect(explained[0].repo).toBe("fading/repo");
    expect(explained[0].kind).toBe("star-floor");
    expect(unexplained).toEqual(["gone/away"]);
  });
});

describe("fork classification disagreements", () => {
  const adopters: AdopterState[] = [
    { repo: "openclaw/openclaw", isFork: true, missedRuns: 0 },
    { repo: "Zoo-Code-Org/Zoo-Code", isFork: true, missedRuns: 0 },
    { repo: "agrees/notfork", isFork: false, missedRuns: 0 },
    { repo: "agrees/fork", isFork: true, missedRuns: 0 },
  ];
  const m = metaMap({
    "openclaw/openclaw": meta(388275, 1),
    "Zoo-Code-Org/Zoo-Code": meta(1764, 2),
    "agrees/notfork": meta(10, 3),
    "agrees/fork": forkMeta(1, 4),
  });

  // Set membership, NOT order: `localeCompare` sorts "openclaw" before
  // "Zoo-Code" under an ICU-backed runner and after it under a C locale, so
  // asserting the order here would make the suite depend on the runner's
  // locale. The ordering guarantee gets its own case below, on a pair whose
  // relative order is the same under every collation.
  it("names every repo where the file and the API disagree", () => {
    const out = forkDisagreements(adopters, m);
    expect(out).toHaveLength(2);
    expect(out).toEqual(
      expect.arrayContaining([
        { repo: "openclaw/openclaw", stateSaysFork: true, apiSaysFork: false },
        { repo: "Zoo-Code-Org/Zoo-Code", stateSaysFork: true, apiSaysFork: false },
      ]),
    );
  });

  it("returns them in a stable order, so a diff of two runs is readable", () => {
    // "aaa" < "bbb" < "ccc" in ASCII and in every locale, so this pins the sort
    // without pinning the collation.
    const shuffled: AdopterState[] = [
      { repo: "ccc/three", isFork: true, missedRuns: 0 },
      { repo: "aaa/one", isFork: true, missedRuns: 0 },
      { repo: "bbb/two", isFork: true, missedRuns: 0 },
    ];
    const mm = metaMap({
      "aaa/one": meta(10, 1),
      "bbb/two": meta(10, 2),
      "ccc/three": meta(10, 3),
    });
    expect(forkDisagreements(shuffled, mm).map((d) => d.repo)).toEqual([
      "aaa/one",
      "bbb/two",
      "ccc/three",
    ]);
  });

  it("says nothing when the two agree", () => {
    expect(forkDisagreements([adopters[2], adopters[3]], m)).toEqual([]);
  });

  it("ignores repos the API never resolved", () => {
    expect(forkDisagreements(adopters, metaMap({}))).toEqual([]);
  });

  it("surfaces the disagreement in the summary, naming the repos", () => {
    const md = buildSummary({
      status: "SAFE",
      reasons: [],
      current: [],
      next: [],
      checks: [],
      verifyOnly: false,
      disagreements: forkDisagreements(adopters, m),
    });
    expect(md).toContain("openclaw/openclaw");
    expect(md).toContain("Zoo-Code-Org/Zoo-Code");
    expect(md).toContain("The API's answer was used.");
    // A repo the two agree on must not be dragged into the report.
    expect(md).not.toContain("agrees/notfork");
  });
});

describe("known adopters missing from the incoming scan", () => {
  // Real gap: cacheplane/dawnai runs aimock in packages/testing/src/aimock-runner.ts
  // and in a k8s smoke deployment, and is absent from a 182-entry state file.
  // Nothing is hardcoded onto the wall; the gap is just made visible.
  it("names a mapped repo the state file never mentions", () => {
    const state: AdopterState[] = [{ repo: "mastra-ai/mastra", missedRuns: 0 }];
    expect(missingFromState(state)).toContain("cacheplane/dawnai");
  });

  it("does not report a repo the scan did report", () => {
    const state: AdopterState[] = Object.keys(ADOPTER_DISPLAY).map((repo) => ({
      repo,
      missedRuns: 0,
    }));
    expect(missingFromState(state)).toEqual([]);
  });

  it("matches case-insensitively, so casing drift is not a false alarm", () => {
    expect(
      missingFromState([{ repo: "CACHEPLANE/DAWNAI" }], {
        "cacheplane/dawnai": { name: "x", url: "https://x" },
      }),
    ).toEqual([]);
  });

  it("surfaces the gap in the summary", () => {
    const md = buildSummary({
      status: "SAFE",
      reasons: [],
      current: [],
      next: [],
      checks: [],
      verifyOnly: false,
      missingFromState: ["cacheplane/dawnai"],
    });
    expect(md).toContain("cacheplane/dawnai");
    expect(md).toContain("Known adopters the scan did not report");
  });
});

describe("candidate ranking", () => {
  const adopters: AdopterState[] = [
    { repo: "big/fork", missedRuns: 0 },
    { repo: "mid/repo", missedRuns: 0 },
    { repo: "stale/repo", missedRuns: 3 },
  ];
  const m = metaMap({
    "big/fork": forkMeta(9000),
    "mid/repo": meta(500),
    "stale/repo": meta(99999),
  });

  it("ranks before the fork rule is applied, so exclusions can be measured", () => {
    expect(rankCandidates(adopters, m).map((c) => c.repo)).toEqual(["big/fork", "mid/repo"]);
  });

  it("still drops what the latest scan no longer sees", () => {
    expect(rankCandidates(adopters, m).map((c) => c.repo)).not.toContain("stale/repo");
  });

  // rankCandidates ranks BEFORE the fork rule, deliberately. topCandidate then
  // passes over what the API calls a fork, because the guard it feeds asks "did
  // the wall lose its biggest name?" and a fork was never eligible to be on it.
  it("topCandidate is the biggest name the wall may actually render", () => {
    expect(topCandidate(adopters, m)).toEqual({
      repo: "mid/repo",
      stars: 500,
      forksOutranking: ["big/fork"],
    });
  });

  // Without this, one hand-excluded repo with a big star count would pin
  // topCandidate forever and the wall could never auto-land again.
  it("skips exclude-listed repos so a rejected copy cannot pin the guard", () => {
    const excluded = EXCLUDED_SUBJECT;
    const withCopy: AdopterState[] = [{ repo: excluded, missedRuns: 0 }, ...adopters];
    const mm = metaMap({ ...Object.fromEntries(m), [excluded]: meta(999999, 9) });
    expect(rankCandidates(withCopy, mm).map((c) => c.repo)).not.toContain(excluded);
    expect(topCandidate(withCopy, mm)?.repo).toBe("mid/repo");
  });

  it("topCandidate is null when nothing resolved", () => {
    expect(topCandidate([], metaMap({}))).toBeNull();
  });

  // rankCandidates does not apply the star floor, so on a run where nothing
  // clears it the highest-starred candidate is one the wall was never ALLOWED to
  // render. Nominating it makes classify report a silent deletion that never
  // happened, pointing a human at the wrong thing on the run that most needs
  // them looking at the right one.
  it("topCandidate passes over a repo below the star floor", () => {
    const below: AdopterState[] = [
      { repo: "small/a", missedRuns: 0 },
      { repo: "small/b", missedRuns: 0 },
    ];
    const m = metaMap({
      "small/a": meta(STAR_FLOOR - 1, 1),
      "small/b": meta(STAR_FLOOR - 2, 2),
    });
    expect(topCandidate(below, m)).toBeNull();
    const r = classify({
      current: [],
      next: [],
      changed: false,
      checks: [],
      minWallSize: 0,
      topCandidate: topCandidate(below, m),
    });
    expect(r.reasons).toEqual([]);
  });

  it("topCandidate still nominates a repo sitting exactly on the floor", () => {
    const m = metaMap({ "on/floor": meta(STAR_FLOOR, 1) });
    expect(topCandidate([{ repo: "on/floor", missedRuns: 0 }], m)?.repo).toBe("on/floor");
  });

  // The predicate the wall itself uses, so the "what did the exclude list do"
  // report can never describe a wall nobody rendered.
  it("clearsWallFilters agrees with what the wall renders", () => {
    const m = metaMap({
      "keeps/it": meta(OK_STARS, 1),
      "too/small": meta(STAR_FLOOR - 1, 2),
      "is/fork": { stars: OK_STARS, ownerId: 3, isFork: true },
    });
    expect(clearsWallFilters({ repo: "keeps/it", missedRuns: 0 }, m)).toBe(true);
    expect(clearsWallFilters({ repo: "keeps/it", missedRuns: 2 }, m)).toBe(false);
    expect(clearsWallFilters({ repo: "too/small", missedRuns: 0 }, m)).toBe(false);
    expect(clearsWallFilters({ repo: "is/fork", missedRuns: 0 }, m)).toBe(false);
    expect(clearsWallFilters({ repo: "never/resolved", missedRuns: 0 }, m)).toBe(false);
  });
});

describe("batched repo metadata query", () => {
  it("asks the API for fork, stars and the numeric owner id", () => {
    const q = buildRepoMetaQuery(["a/one"]);
    expect(q).toContain("isFork");
    expect(q).toContain("stargazerCount");
    expect(q).toContain("databaseId");
    expect(q).toContain('repository(owner: "a", name: "one")');
  });

  it("aliases each repo so one request resolves many", () => {
    const q = buildRepoMetaQuery(["a/one", "b/two", "c/three"]);
    expect(q).toContain("r0: repository");
    expect(q).toContain("r1: repository");
    expect(q).toContain("r2: repository");
  });

  it("quotes hostile owner and repo names rather than interpolating them raw", () => {
    const q = buildRepoMetaQuery(['ev"il/re"po']);
    expect(q).toContain('owner: "ev\\"il"');
    expect(q).not.toContain('owner: "ev"il"');
  });
});

describe("renderWall", () => {
  const hostile: WallEntry[] = [
    {
      repo: `evil"><script>alert(1)</script>/x`,
      name: `evil"><script>`,
      url: `https://github.com/evil"><script>`,
      logo: avatarUrl(7),
      stars: 1,
      mapped: false,
      chip: false,
      monogram: false,
    },
  ];

  it("emits no unescaped markup from untrusted values", () => {
    const html = renderWall(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;");
  });

  it("gives every image explicit dimensions, lazy loading and no referrer", () => {
    const html = renderWall(hostile);
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    // The name sits beside the logo, so the image is decorative.
    expect(html).toContain('alt=""');
  });

  // This case used to assert a NEGATIVE match against `hostile` — a fixture the
  // test builds from its own `avatarUrl(7)` call — so the only thing it could
  // ever prove was that the helper it had just called agreed with itself. The
  // producer the wall actually ships, `selectAdopters` building
  // `logo: avatarUrl(m.ownerId)`, was never run. It is run below.
  it("hot-links the CDN by numeric owner id, never by login", () => {
    expect(avatarUrl(9828093)).toBe("https://avatars.githubusercontent.com/u/9828093?s=128&v=4");
    expect(renderWall(hostile)).not.toMatch(/avatars\.githubusercontent\.com\/(?!u\/)/);
  });
});

describe("logo URLs come out of the real producer as numeric-id CDN URLs", () => {
  // Login-shaped org names, deliberately: if the producer ever reached for a
  // login instead of the API's numeric ownerId, these are the strings that
  // would show up in the URL.
  const adopters: AdopterState[] = [
    { repo: "openclaw/openclaw", missedRuns: 0 },
    { repo: "Zoo-Code-Org/Zoo-Code", missedRuns: 0 },
  ];
  const m = metaMap({
    "openclaw/openclaw": meta(OK_STARS, 9828093),
    "Zoo-Code-Org/Zoo-Code": meta(OK_STARS, 42),
  });
  const NUMERIC_AVATAR = /^https:\/\/avatars\.githubusercontent\.com\/u\/\d+\?s=128&v=4$/;

  it("selectAdopters cannot produce a login-shaped avatar URL", () => {
    const logos = selectAdopters(adopters, m).map((e) => e.logo);
    expect(logos).toHaveLength(2);
    for (const logo of logos) expect(logo).toMatch(NUMERIC_AVATAR);
    // The org logins are IN the input and must be nowhere in the output.
    expect(logos.join(" ")).not.toMatch(/openclaw|zoo-code/i);
    // And the numbers that are there are the ownerIds the API handed us, not
    // some other number that merely happens to match the shape.
    expect(logos).toContain(avatarUrl(9828093));
    expect(logos).toContain(avatarUrl(42));
  });

  it("and the markup the page ships carries only those URLs", () => {
    const html = renderWall(selectAdopters(adopters, m));
    const srcs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((match) => match[1]);
    // Two tiles, duplicated into the marquee's second track.
    expect(srcs).toHaveLength(4);
    for (const src of srcs) expect(decodeHtml(src)).toMatch(NUMERIC_AVATAR);
  });
});

describe("region replacement", () => {
  it("touches only the bytes between the sentinels", () => {
    const out = replaceRegion(PAGE, "REPLACED");
    expect(out.startsWith("<div>\n  <!-- adoption-wall:start -->")).toBe(true);
    expect(out.endsWith("<!-- adoption-wall:end -->\n</div>\n")).toBe(true);
    expect(out).not.toContain("<!-- old -->");
    expect(out).toContain("REPLACED");
  });

  it("throws rather than guessing when the sentinels are missing", () => {
    expect(() => replaceRegion("<div></div>", "x")).toThrow(/sentinels/i);
  });

  it("round-trips render -> parse", () => {
    const entries: WallEntry[] = [
      {
        repo: "a/one",
        name: "One & Co",
        url: "https://one.example",
        logo: avatarUrl(11),
        stars: 5,
        mapped: true,
        chip: false,
        monogram: false,
      },
      {
        repo: "b/two",
        name: "Two",
        url: "https://two.example",
        logo: avatarUrl(22),
        stars: 4,
        mapped: true,
        chip: false,
        monogram: false,
      },
    ];
    const parsed = parseWall(replaceRegion(PAGE, renderWall(entries)));
    expect(parsed).toEqual(
      entries.map((e) => ({ repo: e.repo, name: e.name, url: e.url, logo: e.logo })),
    );
  });
});

describe("classify", () => {
  const tile = (repo: string) => ({ repo, name: repo, url: "u", logo: "l" });
  /** A wall comfortably above MIN_WALL_SIZE, so size never confounds a case. */
  const wall = (n: number, prefix = "org") =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}/r`);
  const bigCurrent = wall(MIN_WALL_SIZE).map(tile);
  const bigNext = wall(MIN_WALL_SIZE).map((repo) => ({ repo }) as WallEntry);
  const allOk = wall(MIN_WALL_SIZE).map((repo) => ok(repo));

  it("is CLEAN when logos are healthy and nothing changed", () => {
    const r = classify({ current: bigCurrent, next: bigNext, changed: false, checks: allOk });
    expect(r.status).toBe("CLEAN");
    expect(exitCodeFor(r.status)).toBe(EXIT_CLEAN);
  });

  // The payoff of removing the cap: a new adopter is an insertion, not an
  // eviction, so the common weekly outcome auto-lands with no click.
  it("is SAFE when a new adopter is added and none are evicted", () => {
    const r = classify({
      current: bigCurrent,
      next: [...bigNext, { repo: "brand/new" } as WallEntry],
      changed: true,
      checks: [...allOk, ok("brand/new")],
    });
    expect(r.status).toBe("SAFE");
    expect(exitCodeFor(r.status)).toBe(EXIT_CHANGED_SAFE);
  });

  it("refuses to let the wall shrink", () => {
    const r = classify({
      current: [...bigCurrent, tile("b/two")],
      next: bigNext,
      changed: true,
      checks: allOk,
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons).toEqual(["b/two is on the wall today but absent from the new list."]);
    expect(exitCodeFor(r.status)).toBe(EXIT_NEEDS_REVIEW);
  });

  // The workflow scrapes only the FIRST THREE `!` lines into Slack. An aggregate
  // count in front of the named repos is not extra information, it is one repo's
  // name deleted from the only message a human reads.
  it("spends its reason lines on repo names, not on a count of them", () => {
    const gone = ["x/one", "y/two", "z/three"];
    const r = classify({
      current: [...bigCurrent, ...gone.map(tile)],
      next: bigNext,
      changed: true,
      checks: allOk,
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons).toHaveLength(gone.length);
    for (const repo of gone) {
      expect(r.reasons.slice(0, 3).join(" ")).toContain(repo);
    }
  });

  // An org handover is a slot changing hands, not a removal. Counting it as one
  // put a sentence in front of the named repos that was wrong about both halves.
  it("never describes an org handover as a deliberate removal", () => {
    // One slot changes hands and three tiles vanish unaccounted for. The org
    // handover is a replacement, so calling it a removal both miscounts the run
    // and puts a vaguer sentence ahead of the three repos that need naming.
    const kept = bigNext.slice(0, 5);
    const m = metaMap({
      ...Object.fromEntries(kept.map((e) => [e.repo, meta(OK_STARS, 1)])),
      "acme/old": meta(OK_STARS, 60),
      "acme/new": meta(OK_STARS, 61),
    });
    const r = classify({
      current: [...bigCurrent, tile("acme/old")],
      next: [...kept, { repo: "acme/new" } as WallEntry],
      changed: true,
      checks: allOk,
      minWallSize: 0,
      meta: m,
    });
    expect(r.notes.map((n) => n.kind)).toEqual(["org-handover"]);
    expect(r.reasons.join(" ")).not.toMatch(/removal/);
    expect(r.reasons).toHaveLength(bigCurrent.length - kept.length);
  });

  // A repo respelled between two scans is the same repo. Comparing exact case
  // made a tile stop matching its own successor.
  it("does not call a tile missing because the new list respelled it", () => {
    const r = classify({
      current: [...bigCurrent, tile("Acme/Widget")],
      next: [...bigNext, { repo: "acme/widget" } as WallEntry],
      changed: true,
      checks: allOk,
    });
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe("SAFE");
  });

  it("does not call the flagship excluded because the new list respelled it", () => {
    const r = classify({
      current: bigCurrent,
      next: [...bigNext, { repo: "acme/widget" } as WallEntry],
      changed: true,
      checks: allOk,
      topCandidate: { repo: "Acme/Widget", stars: 5000 },
    });
    expect(r.reasons).toEqual([]);
  });

  it("flags an adopter dropping off the wall even when the count holds", () => {
    const r = classify({
      current: [...bigCurrent.slice(1), tile("b/two")],
      next: bigNext,
      changed: true,
      checks: allOk,
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons.join(" ")).toContain("b/two is on the wall today but absent");
  });

  // FLOOR 1. Independent of every data signal: whatever the input said, a wall
  // this small does not reach main on its own.
  it("is NEEDS-REVIEW below the minimum wall size, even growing with healthy logos", () => {
    const small = wall(MIN_WALL_SIZE - 1);
    const r = classify({
      current: [],
      next: small.map((repo) => ({ repo }) as WallEntry),
      changed: true,
      checks: small.map((repo) => ok(repo)),
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons.join(" ")).toContain(
      `Wall would render only ${MIN_WALL_SIZE - 1} adopter(s), below the minimum of ${MIN_WALL_SIZE}`,
    );
    expect(exitCodeFor(r.status)).toBe(EXIT_NEEDS_REVIEW);
  });

  it("is not tripped by the floor at exactly the minimum", () => {
    const r = classify({ current: [], next: bigNext, changed: true, checks: allOk });
    expect(r.status).toBe("SAFE");
  });

  // FLOOR 2. The openclaw case in guardrail form: the flagship adopter must
  // never be excluded silently, no matter how big and healthy the wall is.
  it("is NEEDS-REVIEW when the highest-starred candidate is excluded", () => {
    const r = classify({
      current: bigCurrent,
      next: bigNext,
      changed: true,
      checks: allOk,
      topCandidate: { repo: "openclaw/openclaw", stars: 388275 },
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons.join(" ")).toContain(
      "Highest-starred candidate openclaw/openclaw (388275 stars) was excluded from the wall.",
    );
    expect(exitCodeFor(r.status)).toBe(EXIT_NEEDS_REVIEW);
  });

  it("the two floors fire independently of each other", () => {
    // Top candidate present, size below the floor -> only the size reason.
    const small = wall(MIN_WALL_SIZE - 1);
    const sizeOnly = classify({
      current: [],
      next: small.map((repo) => ({ repo }) as WallEntry),
      changed: true,
      checks: small.map((repo) => ok(repo)),
      topCandidate: { repo: small[0], stars: 10 },
    });
    expect(sizeOnly.reasons).toHaveLength(1);
    expect(sizeOnly.reasons[0]).toContain("below the minimum");

    // Size fine, top candidate missing -> only the top-candidate reason.
    const topOnly = classify({
      current: [],
      next: bigNext,
      changed: true,
      checks: allOk,
      topCandidate: { repo: "gone/away", stars: 99 },
    });
    expect(topOnly.reasons).toHaveLength(1);
    expect(topOnly.reasons[0]).toContain("Highest-starred candidate gone/away");
  });

  // THE FALSE ALARM THIS EXISTS TO PREVENT. A tile leaving because it fell under
  // the star floor is a decision taking effect, not an adopter vanishing, so the
  // run must stay SAFE and auto-land -- and must still SAY what left.
  it("stays SAFE when a tile drops below the star floor, and reports it as a note", () => {
    const current = [...bigCurrent, tile("fading/repo")];
    const m = metaMap({
      ...Object.fromEntries(bigNext.map((e) => [e.repo, meta(OK_STARS, 1)])),
      "fading/repo": meta(STAR_FLOOR - 1, 99),
    });
    const r = classify({ current, next: bigNext, changed: true, checks: allOk, meta: m });
    expect(r.status).toBe("SAFE");
    expect(exitCodeFor(r.status)).toBe(EXIT_CHANGED_SAFE);
    expect(r.reasons).toEqual([]);
    expect(r.notes.map((n) => n.repo)).toEqual(["fading/repo"]);
    expect(r.notes[0].kind).toBe("star-floor");
  });

  it("stays SAFE when a tile is removed by the exclude list", () => {
    const excluded = EXCLUDED_SUBJECT;
    const current = [...bigCurrent, tile(excluded)];
    const m = metaMap({ [excluded]: meta(99999, 99) });
    const r = classify({ current, next: bigNext, changed: true, checks: allOk, meta: m });
    expect(r.status).toBe("SAFE");
    expect(r.reasons).toEqual([]);
    expect(r.notes.map((n) => n.kind)).toEqual(["exclude-list"]);
  });

  // The alarm must survive the new leniency: an unexplained drop still gates.
  it("still raises NEEDS-REVIEW for an unexplained drop alongside an explained one", () => {
    const current = [...bigCurrent, tile("fading/repo"), tile("gone/away")];
    const m = metaMap({
      ...Object.fromEntries(bigNext.map((e) => [e.repo, meta(OK_STARS, 1)])),
      "fading/repo": meta(STAR_FLOOR - 1, 99),
    });
    const r = classify({ current, next: bigNext, changed: true, checks: allOk, meta: m });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons.join(" ")).toContain("gone/away is on the wall today but absent");
    expect(r.reasons.join(" ")).not.toContain("fading/repo");
    expect(r.notes.map((n) => n.repo)).toEqual(["fading/repo"]);
  });

  it("the shrink test measures against the size after deliberate removals", () => {
    // Three tiles leave, all below the floor. The raw count shrinks, but nothing
    // shrank beyond what we chose, so there is no shrink reason.
    const fading = ["a/x", "b/y", "c/z"];
    const current = [...bigCurrent, ...fading.map(tile)];
    const m = metaMap({
      ...Object.fromEntries(bigNext.map((e) => [e.repo, meta(OK_STARS, 1)])),
      ...Object.fromEntries(fading.map((r, i) => [r, meta(STAR_FLOOR - 1, 50 + i)])),
    });
    const r = classify({ current, next: bigNext, changed: true, checks: allOk, meta: m });
    expect(r.status).toBe("SAFE");
    expect(r.reasons.join(" ")).not.toMatch(/shrink/);
    expect(r.notes).toHaveLength(3);
  });

  it("is SAFE when the highest-starred candidate did survive", () => {
    const r = classify({
      current: bigCurrent,
      next: bigNext,
      changed: true,
      checks: allOk,
      topCandidate: { repo: bigNext[0].repo, stars: 388275 },
    });
    expect(r.status).toBe("SAFE");
  });

  // The regression this guardrail exists for: the wall was right when written,
  // and an org rotated its avatar six weeks later.
  it("is NEEDS-REVIEW for a dead logo even when the adopter list is identical", () => {
    const r = classify({
      current: bigCurrent,
      next: bigNext,
      changed: false,
      checks: [dead("a/one", "https://cdn/x")],
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons[0]).toContain("a/one");
    expect(r.reasons[0]).toContain("HTTP 404");
  });

  it("treats an unverifiable logo as NEEDS-REVIEW, never SAFE", () => {
    const r = classify({
      current: bigCurrent,
      next: bigNext,
      changed: false,
      checks: [inconclusive("a/one")],
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons[0]).toMatch(/could not be verified/);
  });

  // A verify-only run has no `next`, so neither floor has anything to measure
  // and must stay silent rather than fire on an absent list.
  it("verify-only runs classify with no candidate list", () => {
    expect(
      classify({
        current: [tile("a/one")],
        next: null,
        changed: false,
        checks: [ok("a/one")],
        topCandidate: { repo: "openclaw/openclaw", stars: 388275 },
      }).status,
    ).toBe("CLEAN");
  });
});

describe("one tile per org", () => {
  // Two repos from the same org would render as two identical logos with the
  // same name — visibly wrong on a wall of teams.
  it("keeps only the org's highest-ranked repo", () => {
    const adopters: AdopterState[] = [
      { repo: "acme/low", isFork: false, missedRuns: 0 },
      { repo: "acme/high", isFork: false, missedRuns: 0 },
      { repo: "other/repo", isFork: false, missedRuns: 0 },
    ];
    const m = metaMap({
      "acme/low": meta(OK_STARS, 1),
      "acme/high": meta(900, 1),
      "other/repo": meta(500, 2),
    });
    expect(selectAdopters(adopters, m).map((e) => e.repo)).toEqual(["acme/high", "other/repo"]);
  });

  it("treats org names case-insensitively", () => {
    const adopters: AdopterState[] = [
      { repo: "Acme/one", isFork: false, missedRuns: 0 },
      { repo: "acme/two", isFork: false, missedRuns: 0 },
    ];
    const m = metaMap({ "Acme/one": meta(OK_STARS, 1), "acme/two": meta(OK_STARS - 1, 1) });
    expect(selectAdopters(adopters, m)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Marquee rendering
// ─────────────────────────────────────────────────────────────────────────────

const entry = (repo: string, over: Partial<WallEntry> = {}): WallEntry => ({
  repo,
  name: repo.split("/")[1] ?? repo,
  url: `https://example.com/${repo}`,
  logo: avatarUrl(repo.length),
  stars: 100,
  mapped: true,
  chip: false,
  monogram: false,
  ...over,
});

describe("marquee duration", () => {
  // A hardcoded duration would make the strip faster with every adopter added,
  // and the wall is uncapped on purpose. Time per tile is what must stay fixed.
  it("keeps the time a tile takes to cross constant as the wall grows", () => {
    const perTile = (n: number) => marqueeDuration(n) / n;
    expect(perTile(22)).toBeCloseTo(MARQUEE_SECONDS_PER_TILE, 1);
    expect(perTile(60)).toBeCloseTo(MARQUEE_SECONDS_PER_TILE, 1);
    expect(marqueeDuration(44)).toBeGreaterThan(marqueeDuration(22));
  });

  it("puts the current 22-tile wall at 64 seconds", () => {
    expect(marqueeDuration(22)).toBe(64);
  });

  it("never runs faster than the floor, however few tiles remain", () => {
    expect(marqueeDuration(1)).toBe(MARQUEE_MIN_SECONDS);
    expect(marqueeDuration(0)).toBe(MARQUEE_MIN_SECONDS);
  });

  it("writes the duration onto the rendered element rather than the stylesheet", () => {
    expect(renderWall([entry("a/one"), entry("b/two")])).toContain(
      `--marquee-duration: ${marqueeDuration(2)}s`,
    );
  });
});

describe("marquee tracks", () => {
  const entries = [entry("a/one"), entry("b/two"), entry("c/three")];
  const html = renderWall(entries);

  it("emits two identical tracks so the loop can be seamless", () => {
    expect(html.match(/<div class="adopter-track">/g)).toHaveLength(1);
    expect(html.match(/<div class="adopter-track" aria-hidden="true">/g)).toHaveLength(1);
    expect(html.match(/class="adopter"/g)).toHaveLength(entries.length * 2);
  });

  // The duplicate exists for the animation and for nothing else. A screen
  // reader and a keyboard user must meet each company exactly once.
  it("hides the duplicate from assistive tech and from the tab order", () => {
    const clones = [...html.matchAll(/<a class="adopter"[^>]*>/g)].filter((m) =>
      m[0].includes('data-clone="true"'),
    );
    expect(clones).toHaveLength(entries.length);
    for (const c of clones) expect(c[0]).toContain('tabindex="-1"');
    // ...and none of the real tiles carries either attribute.
    const real = [...html.matchAll(/<a class="adopter"[^>]*>/g)].filter(
      (m) => !m[0].includes("data-clone"),
    );
    expect(real).toHaveLength(entries.length);
    for (const r of real) expect(r[0]).not.toContain("tabindex");
  });

  it("counts each adopter once on the way back in", () => {
    expect(parseWall(replaceRegion(PAGE, html)).map((t) => t.repo)).toEqual(
      entries.map((e) => e.repo),
    );
  });

  it("refuses a half-written duplicate track rather than rendering a jump", () => {
    const broken = html.replace(/<a class="adopter"[^>]*data-clone="true"[\s\S]*?<\/a>/, "");
    expect(() => parseWall(replaceRegion(PAGE, broken))).toThrow(/two tracks must match/i);
  });

  it("ships a pause control, because hover is unreachable on touch", () => {
    expect(html).toContain('class="adopter-marquee-toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-paused="false"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Curated per-logo treatment
// ─────────────────────────────────────────────────────────────────────────────

describe("chip and monogram flags", () => {
  it("renders a chip logo on its own ground, same 40x40 footprint", () => {
    const html = renderWall([entry("k/karakeep", { chip: true })]);
    expect(html).toContain('class="adopter-logo adopter-logo--chip"');
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
  });

  it("leaves every other logo alone", () => {
    expect(renderWall([entry("a/one")])).not.toContain("adopter-logo--chip");
  });

  // Karakeep's avatar is one colour, pure black. Without the chip it is an
  // invisible square on --bg-deep, and greyscale-at-rest makes it worse.
  it("keeps the chip on Karakeep, whose logo is pure black", () => {
    expect(ADOPTER_DISPLAY["karakeep-app/karakeep"].chip).toBe(true);
    expect(resolveDisplay("karakeep-app/karakeep").chip).toBe(true);
  });

  it("renders a monogram tile with no image at all", () => {
    const html = renderWall([entry("x/y", { name: "Quiet Corp", monogram: true })]);
    expect(html).toContain('<span class="adopter-monogram" aria-hidden="true">Q</span>');
    expect(html).not.toContain("<img");
  });

  // The footprint has to match a real logo or the strip shifts when one appears.
  it("keeps the monogram tile the same shape as a logo tile", () => {
    const withLogo = renderWall([entry("x/y", { name: "Quiet Corp" })]);
    const withMono = renderWall([entry("x/y", { name: "Quiet Corp", monogram: true })]);
    // Everything around the logo element must be byte-identical; only the mark
    // itself differs. If the anchor, the name or the wrapper drifted, the tile
    // would be a different size and the strip would jump when one appeared.
    const strip = (h: string) =>
      h.replace(/<img\b[^>]*\/>|<span class="adopter-monogram"[^>]*>[^<]*<\/span>/g, "@LOGO@");
    expect(strip(withMono)).toBe(strip(withLogo));
    expect(withMono).toContain('class="adopter"');
    expect(withMono).toContain('<span class="adopter-name">Quiet Corp</span>');
  });

  it("round-trips a monogram tile with an empty logo, not a shifted one", () => {
    const entries = [entry("a/one"), entry("b/two", { name: "Bee", monogram: true }), entry("c/x")];
    const parsed = parseWall(replaceRegion(PAGE, renderWall(entries)));
    expect(parsed.map((t) => t.repo)).toEqual(["a/one", "b/two", "c/x"]);
    // The bug this guards: sweeping the region for <img src> separately would
    // hand c/x the logo belonging to b/two.
    expect(parsed[1].logo).toBe("");
    expect(parsed[2].logo).toBe(entries[2].logo);
  });

  it("escapes the monogram letter like everything else", () => {
    expect(renderWall([entry("x/y", { name: "<script>", monogram: true })])).toContain("&lt;");
    expect(monogramLetter("  ácme")).toBe("Á");
    expect(monogramLetter("")).toBe("?");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Adopter state on the orphan branch
// ─────────────────────────────────────────────────────────────────────────────

describe("adopter state loading", () => {
  it("reads the state from a plain local path, no network involved", () => {
    const load = loadAdopterState(
      fileURLToPath(new URL("./fixtures/adopters-state.json", import.meta.url)),
    );
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") throw new Error("unreachable");
    expect(load.state.adopters?.map((a) => a.repo)).toEqual(["a/one", "b/two"]);
  });

  // The expected state before the weekly routine's first push to the orphan
  // branch. Benign: the caller renders nothing and leaves docs/ untouched.
  it("calls an absent file MISSING, not corrupt", () => {
    const load = loadAdopterState("/nonexistent/adoption-data/adopters.json");
    expect(load.kind).toBe("missing");
  });

  // The opposite case. A file that IS there and cannot be read is a broken
  // producer, and it must not leave the wall frozen on last week's answer.
  it("calls an unparseable file CORRUPT, not missing", () => {
    expect(parseAdopterState("{ not json", "f.json").kind).toBe("corrupt");
    expect(parseAdopterState("[]", "f.json").kind).toBe("corrupt");
    expect(parseAdopterState("null", "f.json").kind).toBe("corrupt");
    expect(parseAdopterState('{"adopters": "nope"}', "f.json").kind).toBe("corrupt");
  });

  it("accepts a well-formed file with no adopters key", () => {
    expect(parseAdopterState('{"lastScan":"2026-01-01"}', "f.json").kind).toBe("ok");
  });

  it("carries the corrupt detail into the run's reasons, forcing NEEDS-REVIEW", () => {
    const load = parseAdopterState("{ not json", "adopters.json");
    if (load.kind !== "corrupt") throw new Error("unreachable");
    const { status, reasons } = classify({
      current: [],
      next: null,
      changed: false,
      checks: [],
      extraReasons: [load.detail],
    });
    expect(status).toBe("NEEDS-REVIEW");
    expect(exitCodeFor(status)).toBe(EXIT_NEEDS_REVIEW);
    expect(reasons.join(" ")).toMatch(/not valid JSON/);
  });

  // Missing state must NOT invent a reason: with healthy logos the run is CLEAN.
  it("stays CLEAN when the state is merely absent and the logos are healthy", () => {
    const { status } = classify({
      current: [{ repo: "a/one", name: "One", url: "u", logo: "l" }],
      next: null,
      changed: false,
      checks: [ok("a/one")],
    });
    expect(status).toBe("CLEAN");
    expect(exitCodeFor(status)).toBe(EXIT_CLEAN);
  });

  it("names the orphan branch and file the workflow checks out", () => {
    expect(STATE_BRANCH).toBe("adoption-data");
    expect(STATE_FILE).toBe("adopters.json");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-1 code review: generator honesty
//
// Everything below was added in one pass to close review findings against
// scripts/update-adoption-wall.ts. Each block names the failure it pins.
// ─────────────────────────────────────────────────────────────────────────────

describe("an API-confirmed fork cannot wedge the flagship guard", () => {
  // The guard exists so the biggest adopter can never quietly vanish. But
  // topCandidate used to hand classify a repo the API itself calls a fork —
  // which selectAdopters is REQUIRED to drop — so the run pinned NEEDS-REVIEW
  // every week with no way to clear it short of hand-editing the deny list.
  const adopters: AdopterState[] = [
    { repo: "somebody/big-fork", missedRuns: 0 },
    { repo: "real/adopter", missedRuns: 0 },
  ];
  const m = metaMap({
    "somebody/big-fork": forkMeta(999999, 7),
    "real/adopter": meta(OK_STARS, 8),
  });

  it("passes over the fork and names the next real candidate", () => {
    expect(topCandidate(adopters, m)?.repo).toBe("real/adopter");
  });

  it("reports the fork it passed over rather than swallowing it", () => {
    expect(topCandidate(adopters, m)?.forksOutranking).toEqual(["somebody/big-fork"]);
  });

  it("does not wedge: the run classifies SAFE with the fork sitting on top", () => {
    const next = selectAdopters(adopters, m);
    const { status, reasons } = classify({
      current: [],
      next,
      changed: true,
      checks: [],
      topCandidate: topCandidate(adopters, m),
      minWallSize: 1,
      meta: m,
    });
    expect(reasons).toEqual([]);
    expect(status).toBe("SAFE");
  });

  // The wedge fix must NOT creep into rankCandidates: that function deliberately
  // ranks before the fork rule so the cost of the rule stays measurable, and the
  // openclaw incident is what happens when a fork flag prunes the candidate list.
  it("leaves rankCandidates ranking before the fork rule", () => {
    expect(rankCandidates(adopters, m).map((c) => c.repo)).toEqual([
      "somebody/big-fork",
      "real/adopter",
    ]);
  });

  // A candidate the API says is NOT a fork but that vanished for some other
  // reason must still alarm — that is the whole point of the guard.
  it("still alarms when the top candidate vanishes for any other reason", () => {
    const { status, reasons } = classify({
      current: [],
      next: [],
      changed: true,
      checks: [],
      topCandidate: { repo: "real/adopter", stars: OK_STARS },
      minWallSize: 0,
      meta: m,
    });
    expect(status).toBe("NEEDS-REVIEW");
    expect(reasons.join(" ")).toContain("real/adopter");
  });
});

describe("a slot changing hands inside one org", () => {
  const tile = (repo: string) => ({ repo, name: repo, url: "u", logo: "l" });

  it("is explained, not an unexplained disappearance", () => {
    const current = [tile("acme/old"), tile("other/repo")];
    const next = [{ repo: "acme/new" } as WallEntry, { repo: "other/repo" } as WallEntry];
    const m = metaMap({ "acme/old": meta(OK_STARS, 1), "acme/new": meta(OK_STARS * 2, 1) });
    const { explained, unexplained } = partitionDrops(current, next, m);
    expect(unexplained).toEqual([]);
    expect(explained.map((e) => e.kind)).toEqual(["org-handover"]);
    expect(explained[0].detail).toContain("acme/new");
  });

  it("keeps the run SAFE instead of raising a false alarm", () => {
    const current = [tile("acme/old")];
    const next = [{ repo: "acme/new", stars: 1 } as WallEntry];
    const m = metaMap({ "acme/old": meta(OK_STARS, 1), "acme/new": meta(OK_STARS * 2, 1) });
    const { status } = classify({
      current,
      next,
      changed: true,
      checks: [],
      minWallSize: 1,
      meta: m,
    });
    expect(status).toBe("SAFE");
  });

  it("still alarms when nobody from that org took the slot", () => {
    const current = [tile("acme/old")];
    const next = [{ repo: "other/repo" } as WallEntry];
    const m = metaMap({ "acme/old": meta(OK_STARS, 1) });
    expect(partitionDrops(current, next, m).unexplained).toEqual(["acme/old"]);
  });

  // "The slot changed hands" and "the repo is gone" are opposite facts. Without
  // asking whether the departing repo still resolves, an adopter being deleted,
  // made private or taken down was filed as a note the moment any sibling repo
  // from the same org was on the new list — and a note does not gate, so the run
  // reported SAFE and the workflow pushed the shrunken wall to main.
  it("is NOT a handover when the departing repo no longer exists", () => {
    const current = [tile("acme/old")];
    const next = [{ repo: "acme/new" } as WallEntry];
    const m = metaMap({ "acme/new": meta(OK_STARS * 2, 1) });
    const { explained, unexplained } = partitionDrops(current, next, m);
    expect(explained).toEqual([]);
    expect(unexplained).toEqual(["acme/old"]);
    expect(
      classify({ current, next, changed: true, checks: [], minWallSize: 1, meta: m }).status,
    ).toBe("NEEDS-REVIEW");
  });
});

describe("a repo respelled between two scans is the same repo", () => {
  const tile = (repo: string) => ({ repo, name: repo, url: "u", logo: "l" });

  it("a survivor the new list recased has not left the wall", () => {
    const current = [tile("Acme/Widget")];
    const next = [{ repo: "acme/widget" } as WallEntry];
    const m = metaMap({ "acme/widget": meta(OK_STARS, 1) });
    expect(partitionDrops(current, next, m)).toEqual({ explained: [], unexplained: [] });
  });

  // The escalation the casing bug caused: explainDrop's meta lookup missed, so a
  // deliberate star-floor removal lost its explanation and came out the other
  // side as an unexplained-disappearance alarm.
  it("keeps a star-floor removal explained when the new list recased it", () => {
    const m = metaMap({ "acme/widget": meta(STAR_FLOOR - 1, 1) });
    const why = explainDrop("Acme/Widget", m);
    expect(why?.kind).toBe("star-floor");
    expect(why?.stars).toBe(STAR_FLOOR - 1);
  });

  it("metaFor finds a record written under a different casing", () => {
    const m = metaMap({ "Acme/Widget": meta(OK_STARS, 1) });
    expect(metaFor("acme/widget", m)?.stars).toBe(OK_STARS);
    expect(metaFor("other/repo", m)).toBeUndefined();
  });
});

describe("the same-org runner-up is reported, not silently dropped", () => {
  const adopters: AdopterState[] = [
    { repo: "cacheplane/dawnai", missedRuns: 0 },
    { repo: "cacheplane/angular-agent-framework", missedRuns: 0 },
    { repo: "other/repo", missedRuns: 0 },
  ];
  const m = metaMap({
    "cacheplane/dawnai": meta(OK_STARS * 2, 5),
    "cacheplane/angular-agent-framework": meta(OK_STARS, 5),
    "other/repo": meta(OK_STARS, 6),
  });

  it("names the curated adopter the org dedupe removed", () => {
    const runners = orgRunnersUp(adopters, m);
    expect(runners.map((r) => r.repo)).toEqual(["cacheplane/angular-agent-framework"]);
    expect(runners[0].winner).toBe("cacheplane/dawnai");
  });

  it("says so in the summary, so the drop is never invisible", () => {
    const md = buildSummary({
      status: "SAFE",
      reasons: [],
      current: [],
      next: selectAdopters(adopters, m),
      checks: [],
      verifyOnly: false,
      orgRunnersUp: orgRunnersUp(adopters, m),
    });
    expect(md).toContain("cacheplane/angular-agent-framework");
    expect(md).toContain("cacheplane/dawnai");
  });
});

describe("curated display names survive casing drift", () => {
  it("matches ADOPTER_DISPLAY case-insensitively", () => {
    const canonical = "mastra-ai/mastra";
    const drifted = "Mastra-AI/Mastra";
    expect(resolveDisplay(drifted).name).toBe(ADOPTER_DISPLAY[canonical].name);
    expect(resolveDisplay(drifted).mapped).toBe(true);
  });
});

describe("parseWall reads what prettier actually wrote", () => {
  it("finds the name even when the span's attributes wrapped onto their own line", () => {
    const tileHtml = (clone: boolean) =>
      `<a\n  class="adopter"\n  href="https://x.example"\n  data-repo="a/one"${clone ? '\n  data-clone="true"' : ""}\n>\n<img class="adopter-logo" src="l" />\n<span\n  class="adopter-name"\n  >Acme Corp</span\n>\n</a>`;
    const wrapped = `${tileHtml(false)}\n${tileHtml(true)}`;
    const parsed = parseWall(replaceRegion(PAGE, wrapped));
    expect(parsed[0].name).toBe("Acme Corp");
  });

  it("refuses a wall whose duplicate track is missing entirely", () => {
    const real = `<a class="adopter" href="u" data-repo="a/one"><span class="adopter-name">One</span></a>`;
    expect(() => parseWall(replaceRegion(PAGE, real))).toThrow(/two tracks must match/i);
  });

  it("accepts an empty region: no tiles and no duplicates still match", () => {
    expect(parseWall(PAGE)).toEqual([]);
  });
});

describe("fork disagreement needs an actual claim to disagree with", () => {
  it("treats an absent isFork as no claim, not as 'not a fork'", () => {
    const adopters: AdopterState[] = [{ repo: "a/one", missedRuns: 0 }];
    expect(forkDisagreements(adopters, metaMap({ "a/one": forkMeta(10) }))).toEqual([]);
  });

  it("still reports an explicit false against an API fork", () => {
    const adopters: AdopterState[] = [{ repo: "a/one", isFork: false, missedRuns: 0 }];
    expect(forkDisagreements(adopters, metaMap({ "a/one": forkMeta(10) }))).toHaveLength(1);
  });
});

describe("logo probing", () => {
  it("probes a shared avatar URL once, however many tiles carry it", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response(null, { status: 200, headers: { "content-type": "image/png" } });
    });
    try {
      const out = await checkLogos([
        { url: "https://avatars.example/u/1", repo: "acme/one" },
        { url: "https://avatars.example/u/1", repo: "acme/two" },
      ]);
      expect(out.size).toBe(1);
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits before retrying an inconclusive probe", async () => {
    const slept: number[] = [];
    vi.stubGlobal("fetch", async () => {
      throw new Error("socket hang up");
    });
    try {
      const res = await checkLogo("https://avatars.example/u/1", "acme/one", async (ms) => {
        slept.push(ms);
      });
      expect(res.kind).toBe("inconclusive");
      expect(slept.length).toBeGreaterThan(0);
      expect(slept[0]).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops probing tiles this run is deliberately dropping", () => {
    const current = [
      { repo: "stays/put", name: "s", url: "u", logo: "logo-stays" },
      { repo: "leaving/repo", name: "l", url: "u", logo: "logo-leaving" },
    ];
    const next: WallEntry[] = [{ ...entry("stays/put"), logo: "logo-stays" }];
    const urls = probeTargets(current, next).map((t) => t.url);
    expect(urls).toContain("logo-stays");
    expect(urls).not.toContain("logo-leaving");
  });

  // What departs is a URL, not a repo. A repo can survive to the new wall with a
  // DIFFERENT avatar URL — its owner's databaseId changes when an org is deleted
  // and recreated — and the dead URL still on the page then forces NEEDS-REVIEW
  // on the very run that replaces it.
  it("stops probing the OLD url of a survivor whose avatar changed", () => {
    const current = [{ repo: "stays/put", name: "s", url: "u", logo: "logo-old" }];
    const next: WallEntry[] = [{ ...entry("stays/put"), logo: "logo-new" }];
    const urls = probeTargets(current, next).map((t) => t.url);
    expect(urls).toEqual(["logo-new"]);
  });

  it("does not probe a live tile's url that the new wall renders as a monogram", () => {
    const current = [{ repo: "stays/put", name: "s", url: "u", logo: "logo-old" }];
    const next: WallEntry[] = [{ ...entry("stays/put"), logo: "logo-old", monogram: true }];
    expect(probeTargets(current, next)).toEqual([]);
  });

  it("probes the whole live wall when no candidate list was built", () => {
    const current = [
      { repo: "stays/put", name: "s", url: "u", logo: "logo-stays" },
      { repo: "leaving/repo", name: "l", url: "u", logo: "logo-leaving" },
    ];
    expect(probeTargets(current, null).map((t) => t.url)).toEqual(["logo-stays", "logo-leaving"]);
  });
});

describe("adopter state elements are shape-checked", () => {
  // `{"adopters":[1]}` used to pass as ok and then crash the run with exit 1 —
  // a hard error — where the workflow expects exit 20 and a human review.
  it("calls a non-object adopter entry CORRUPT, not ok", () => {
    expect(parseAdopterState('{"adopters":[1]}', "f.json").kind).toBe("corrupt");
  });

  it("calls an entry with no repo string CORRUPT", () => {
    expect(parseAdopterState('{"adopters":[{"repo":5}]}', "f.json").kind).toBe("corrupt");
    expect(parseAdopterState('{"adopters":[{}]}', "f.json").kind).toBe("corrupt");
  });

  it("rejects a mistyped missedRuns rather than silently ranking on it", () => {
    expect(parseAdopterState('{"adopters":[{"repo":"a/one","missedRuns":"2"}]}', "f").kind).toBe(
      "corrupt",
    );
  });

  it("still accepts a well-formed entry", () => {
    const load = parseAdopterState(
      '{"adopters":[{"repo":"a/one","missedRuns":0,"isFork":false}]}',
      "f.json",
    );
    expect(load.kind).toBe("ok");
  });
});

describe("REST fallback tells rate-limiting from not-found", () => {
  it("throws on a 403 rather than reading it as a vanished repo", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { status: 403, statusText: "rate limit" }),
    );
    try {
      await expect(fetchRepoMetaRest(["a/one"], new Map())).rejects.toThrow(/403/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws on a 429 too", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429, statusText: "too many" }));
    try {
      await expect(fetchRepoMetaRest(["a/one"], new Map())).rejects.toThrow(/429/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps treating a 404 as a repo that is genuinely gone", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("{}", { status: 404, statusText: "Not Found" }),
    );
    try {
      const meta = new Map<string, RepoMeta>();
      await expect(fetchRepoMetaRest(["a/gone"], meta)).resolves.toBeUndefined();
      expect(meta.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("--meta-file is validated, not cast", () => {
  it("rejects a record whose isFork is missing", () => {
    expect(() => parseMetaFile('{"a/one":{"stars":10,"ownerId":1}}', "m.json")).toThrow(/isFork/);
  });

  it("rejects a record whose stars are not a number", () => {
    expect(() =>
      parseMetaFile('{"a/one":{"stars":"10","ownerId":1,"isFork":false}}', "m.json"),
    ).toThrow(/a\/one/);
  });

  it("accepts a well-formed record", () => {
    const m = parseMetaFile('{"a/one":{"stars":10,"ownerId":1,"isFork":true}}', "m.json");
    expect(m.get("a/one")).toEqual({ stars: 10, ownerId: 1, isFork: true });
  });
});

describe("--dry-run never claims something was pushed", () => {
  it("does not return the safe-to-push code when nothing was written", () => {
    expect(exitCodeFor("SAFE", { dryRun: true })).toBe(EXIT_CLEAN);
    expect(exitCodeFor("SAFE")).toBe(EXIT_CHANGED_SAFE);
  });

  it("still returns NEEDS-REVIEW from a dry run", () => {
    expect(exitCodeFor("NEEDS-REVIEW", { dryRun: true })).toBe(EXIT_NEEDS_REVIEW);
  });
});

describe("summary honesty", () => {
  it("shows the HIGHEST star-floor drops when it says it is showing the highest", () => {
    const notes = Array.from({ length: 12 }, (_, i) => ({
      repo: `r/${String(i).padStart(2, "0")}`,
      kind: "star-floor" as const,
      detail: "below the floor",
      stars: i,
    }));
    const md = buildSummary({
      status: "SAFE",
      reasons: [],
      current: [],
      next: [],
      checks: [],
      verifyOnly: false,
      notes,
    });
    expect(md).toContain("`r/11` (11)");
    expect(md).not.toContain("`r/00` (0)");
  });

  it("reports how many repos actually resolved, not how many were asked for", () => {
    const line = resolutionLine(["a/one", "b/two"], metaMap({ "a/one": meta(1) }), 1);
    expect(line).toContain("1 of 2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-1 code review: the suite must not be vacuous
//
// Everything below covers a guard the branch relies on that no test exercised,
// so the guard could have been deleted with the suite staying green. Each block
// was written against a deliberate mutation of the guard and observed to fail.
// ─────────────────────────────────────────────────────────────────────────────

/** Stubs `fetch` for the body of `run`, then always restores it. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => impl(url, init));
  try {
    await run();
  } finally {
    vi.unstubAllGlobals();
  }
}

const imageRes = (status = 200, type = "image/png") =>
  new Response(null, { status, headers: { "content-type": type } });

describe("a 200 is not evidence a logo is alive", () => {
  // THE failure this rule exists for: the GitHub avatar CDN does not 404 on an
  // unresolvable owner id. It 302s to github.com and answers 200 with an HTML
  // page, which a browser paints as a broken image. A status-only probe passes
  // exactly the case the guard was written to catch.
  it("calls a 200 text/html response DEAD, not ok", async () => {
    await withFetch(
      async () =>
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      async () => {
        const res = await checkLogo("https://avatars.githubusercontent.com/u/999999999", "a/one");
        expect(res.ok).toBe(false);
        expect(res.kind).toBe("http");
        expect(res.status).toBe(200);
        expect(res.detail).toContain("text/html");
      },
    );
  });

  it("calls a 200 with NO content-type at all DEAD", async () => {
    await withFetch(
      async () => new Response(null, { status: 200 }),
      async () => {
        const res = await checkLogo("https://avatars.example/u/1", "a/one");
        expect(res.ok).toBe(false);
        expect(res.kind).toBe("http");
      },
    );
  });

  it("accepts an image/* body, whatever the image subtype", async () => {
    for (const type of ["image/png", "IMAGE/JPEG", "image/svg+xml; charset=utf-8"]) {
      await withFetch(
        async () => imageRes(200, type),
        async () => {
          const res = await checkLogo("https://avatars.example/u/1", "a/one");
          expect(res.ok, type).toBe(true);
          expect(res.kind, type).toBe("ok");
        },
      );
    }
  });

  it("accepts the 206 a ranged GET answers with", async () => {
    await withFetch(
      async () => imageRes(206, "image/png"),
      async () => {
        expect((await checkLogo("https://avatars.example/u/1", "a/one")).ok).toBe(true);
      },
    );
  });

  // The dead-logo verdict has to reach classify, or the rule guards nothing that
  // the workflow can act on.
  it("forces NEEDS-REVIEW through classify, even on a byte-identical wall", async () => {
    await withFetch(
      async () =>
        new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
      async () => {
        const check = await checkLogo("https://avatars.example/u/1", "a/one");
        const { status, reasons } = classify({
          current: [],
          next: null,
          changed: false,
          checks: [check],
        });
        expect(status).toBe("NEEDS-REVIEW");
        expect(exitCodeFor(status)).toBe(EXIT_NEEDS_REVIEW);
        expect(reasons.join(" ")).toContain("a/one");
      },
    );
  });
});

describe("probe method and status handling", () => {
  it("re-tries a HEAD-refusing CDN as a one-byte ranged GET", async () => {
    const methods: string[] = [];
    await withFetch(
      async (_url, init) => {
        methods.push(String(init?.method));
        return init?.method === "HEAD" ? new Response(null, { status: 405 }) : imageRes(206);
      },
      async () => {
        const res = await checkLogo("https://avatars.example/u/1", "a/one");
        expect(res.ok).toBe(true);
      },
    );
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("sends a one-byte Range on that GET rather than pulling the whole image", async () => {
    const ranges: (string | undefined)[] = [];
    await withFetch(
      async (_url, init) => {
        ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
        return init?.method === "HEAD" ? new Response(null, { status: 403 }) : imageRes(206);
      },
      async () => {
        await checkLogo("https://avatars.example/u/1", "a/one");
      },
    );
    expect(ranges[1]).toBe("bytes=0-0");
  });

  it("calls a rate-limit or a 5xx INCONCLUSIVE, never dead", async () => {
    for (const status of [429, 500, 503]) {
      await withFetch(
        async () => new Response(null, { status }),
        async () => {
          const res = await checkLogo("https://avatars.example/u/1", "a/one", async () => {});
          expect(res.ok, String(status)).toBe(false);
          expect(res.kind, String(status)).toBe("inconclusive");
        },
      );
    }
  });

  it("calls a 404 dead, and stops after it rather than burning a retry", async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
      async () => {
        const res = await checkLogo("https://avatars.example/u/1", "a/one", async () => {});
        expect(res.kind).toBe("http");
        expect(res.ok).toBe(false);
      },
    );
    expect(calls).toBe(1);
  });

  it("attributes the result to the repo that asked, not to the bare URL", async () => {
    await withFetch(
      async () => new Response(null, { status: 404 }),
      async () => {
        expect((await checkLogo("https://x/u/1", "acme/widget", async () => {})).repo).toBe(
          "acme/widget",
        );
      },
    );
  });

  it("checkLogos keys every target it was handed", async () => {
    await withFetch(
      async () => imageRes(),
      async () => {
        const out = await checkLogos([
          { url: "https://x/u/1", repo: "a/one" },
          { url: "https://x/u/2", repo: "b/two" },
          { url: "https://x/u/3", repo: "c/three" },
        ]);
        expect([...out.keys()].sort()).toEqual(["https://x/u/1", "https://x/u/2", "https://x/u/3"]);
        expect([...out.values()].every((r) => r.ok)).toBe(true);
      },
    );
  });

  it("checkLogos surfaces a dead logo among healthy ones", async () => {
    await withFetch(
      async (url) =>
        url.endsWith("/2")
          ? new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })
          : imageRes(),
      async () => {
        const out = await checkLogos([
          { url: "https://x/u/1", repo: "a/one" },
          { url: "https://x/u/2", repo: "b/two" },
        ]);
        expect(out.get("https://x/u/2")?.ok).toBe(false);
        expect(out.get("https://x/u/1")?.ok).toBe(true);
      },
    );
  });
});

describe("GraphQL tells a missing repo from a broken query", () => {
  const node = (nameWithOwner: string, stars: number, id: number, isFork = false) => ({
    nameWithOwner,
    isFork,
    stargazerCount: stars,
    owner: { databaseId: id },
  });
  const gql = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("treats a per-repo NOT_FOUND as a repo that is gone and keeps the rest", async () => {
    const m = new Map<string, RepoMeta>();
    await withFetch(
      async () =>
        gql({
          data: { r0: node("a/one", 100, 1), r1: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }],
        }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["a/one", "b/gone"], m)).resolves.toBe(1);
      },
    );
    expect([...m.keys()]).toEqual(["a/one"]);
  });

  // The silent-deletion bug in its purest form: a throttle or a malformed query
  // returns SOME repos and an error, and treating that as "those repos are not
  // adopters" deletes them from the wall.
  it("THROWS on any non-NOT_FOUND error rather than dropping repos", async () => {
    for (const type of ["RATE_LIMITED", "FORBIDDEN", undefined]) {
      const m = new Map<string, RepoMeta>();
      await withFetch(
        async () =>
          gql({
            data: { r0: node("a/one", 100, 1), r1: null },
            errors: [{ type, message: "API rate limit exceeded" }],
          }),
        async () => {
          await expect(fetchRepoMetaGraphQL(["a/one", "b/two"], m)).rejects.toThrow(
            /rate limit exceeded/,
          );
        },
      );
    }
  });

  it("throws on a non-200 transport response", async () => {
    await withFetch(
      async () => new Response("nope", { status: 502, statusText: "Bad Gateway" }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["a/one"], new Map())).rejects.toThrow(/502/);
      },
    );
  });

  it("throws when the response carries no data at all", async () => {
    await withFetch(
      async () => gql({ errors: [{ type: "NOT_FOUND", message: "bad query" }] }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["a/one"], new Map())).rejects.toThrow(/no data/);
      },
    );
  });

  // EVERY field, one at a time: as one lumped case the checks are redundant with
  // each other and any one could be deleted while the suite stayed green. A node
  // missing only `owner.databaseId` would otherwise write
  // `avatars.githubusercontent.com/u/undefined` onto the page. `nameWithOwner` is
  // not among them because it is no longer asked for or read — identity is the
  // alias we sent, not the name the API answered with.
  it.each([
    ["owner.databaseId", { isFork: false, stargazerCount: 10 }],
    ["stargazerCount", { isFork: false, owner: { databaseId: 1 } }],
    ["isFork", { stargazerCount: 10, owner: { databaseId: 1 } }],
  ])("skips a node missing %s instead of writing a half-filled RepoMeta", async (_f, node) => {
    const m = new Map<string, RepoMeta>();
    await withFetch(
      async () => gql({ data: { r0: node } }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["a/one"], m)).resolves.toBe(1);
      },
    );
    expect(m.size).toBe(0);
  });

  it("pages the query so a state file bigger than one batch is fully resolved", async () => {
    const repos = Array.from({ length: 150 }, (_, i) => `o${i}/r`);
    const batches: number[] = [];
    const m = new Map<string, RepoMeta>();
    await withFetch(
      async (_url, init) => {
        const query = JSON.parse(String(init?.body)).query as string;
        batches.push((query.match(/repository\(/g) ?? []).length);
        return gql({ data: {} });
      },
      async () => {
        await expect(fetchRepoMetaGraphQL(repos, m)).resolves.toBe(2);
      },
    );
    expect(batches).toEqual([100, 50]);
  });
});

describe("GraphQL metadata is keyed by the name we ASKED about", () => {
  const gql = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  // `repository(owner:, name:)` resolves through renames and answers with the
  // repo's CURRENT nameWithOwner. Keying on the answer means every later lookup
  // by the state file's spelling misses.
  it("keeps a RENAMED repo under its requested name", async () => {
    const m = new Map<string, RepoMeta>();
    await withFetch(
      async () =>
        gql({
          data: {
            r0: {
              nameWithOwner: "new-owner/new-name",
              isFork: false,
              stargazerCount: OK_STARS,
              owner: { databaseId: 7 },
            },
          },
        }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["old-owner/old-name"], m)).resolves.toBe(1);
      },
    );
    expect([...m.keys()]).toEqual(["old-owner/old-name"]);
  });

  it("keeps a canonically-recased repo under the state file's spelling", async () => {
    const m = new Map<string, RepoMeta>();
    await withFetch(
      async () =>
        gql({
          data: {
            r0: {
              nameWithOwner: "Zoo-Code-Org/Zoo-Code",
              isFork: false,
              stargazerCount: OK_STARS,
              owner: { databaseId: 5 },
            },
          },
        }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["zoo-code-org/zoo-code"], m)).resolves.toBe(1);
      },
    );
    expect([...m.keys()]).toEqual(["zoo-code-org/zoo-code"]);
  });

  it("pairs each alias with its OWN repo, not with the order the answer arrived in", async () => {
    const m = new Map<string, RepoMeta>();
    await withFetch(
      async () =>
        gql({
          data: {
            r2: { isFork: false, stargazerCount: 300, owner: { databaseId: 3 } },
            r0: { isFork: false, stargazerCount: 100, owner: { databaseId: 1 } },
            r1: { isFork: false, stargazerCount: 200, owner: { databaseId: 2 } },
          },
        }),
      async () => {
        await expect(fetchRepoMetaGraphQL(["a/one", "b/two", "c/three"], m)).resolves.toBe(1);
      },
    );
    expect(m.get("a/one")?.stars).toBe(100);
    expect(m.get("b/two")?.stars).toBe(200);
    expect(m.get("c/three")?.stars).toBe(300);
  });

  // The end-to-end payoff: a renamed adopter still ranks, and a renamed
  // DENY-LISTED repo is still denied — EXCLUDED_ADOPTERS is written against a
  // name, so an entry keyed on the API's answer would stop applying.
  it("keeps a renamed adopter on the wall and a renamed exclusion excluded", () => {
    const m = metaMap({
      "old-owner/old-name": meta(OK_STARS, 7),
      "rivet-dev/agentos": meta(OK_STARS, 8),
    });
    const adopters: AdopterState[] = [
      { repo: "old-owner/old-name", missedRuns: 0 },
      { repo: "rivet-dev/agentos", missedRuns: 0 },
    ];
    expect(selectAdopters(adopters, m).map((e) => e.repo)).toEqual(["old-owner/old-name"]);
  });
});

describe("the minimum wall size is a real floor, not a default nobody overrides", () => {
  const entries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ repo: `o${i}/r` }) as WallEntry);

  it("uses MIN_WALL_SIZE when the caller supplies no floor", () => {
    const r = classify({
      current: [],
      next: entries(MIN_WALL_SIZE - 1),
      changed: true,
      checks: [],
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons.join(" ")).toContain(`below the minimum of ${MIN_WALL_SIZE}`);
  });

  it("honours a caller-supplied floor ABOVE the default", () => {
    const floor = MIN_WALL_SIZE + 5;
    const r = classify({
      current: [],
      next: entries(MIN_WALL_SIZE),
      changed: true,
      checks: [],
      minWallSize: floor,
    });
    expect(r.status).toBe("NEEDS-REVIEW");
    expect(r.reasons.join(" ")).toContain(
      `Wall would render only ${MIN_WALL_SIZE} adopter(s), below the minimum of ${floor}`,
    );
  });

  it("honours an explicit zero, which is how a fixture-sized run opts out", () => {
    const r = classify({
      current: [],
      next: entries(1),
      changed: true,
      checks: [],
      minWallSize: 0,
    });
    expect(r.reasons).toEqual([]);
    expect(r.status).toBe("SAFE");
  });

  it("does not fire at exactly the floor", () => {
    const r = classify({
      current: [],
      next: entries(MIN_WALL_SIZE),
      changed: true,
      checks: [],
    });
    expect(r.status).toBe("SAFE");
  });

  it("keeps the floor a positive number, so it can never be trivially satisfied", () => {
    expect(MIN_WALL_SIZE).toBeGreaterThan(0);
  });
});

// ── Mutation-testing survivors ───────────────────────────────────────────────
// Each case below was written because a deliberate mutation of the guard it
// covers left the suite GREEN. They are the tests that were missing.

describe("adopter state: entries that are not objects at all", () => {
  // Mutation that survived: deleting the object/null/array check in
  // parseAdopterState. `[1]` still fell through to the repo-string check, so
  // the suite stayed green — but `null` and `[]` do not: `null.repo` THROWS,
  // which exits 1 (a run that failed) instead of 20 (a human should look).
  it("calls a null adopter entry CORRUPT rather than throwing", () => {
    const load = parseAdopterState('{"adopters":[null]}', "f.json");
    expect(load.kind).toBe("corrupt");
    if (load.kind === "corrupt") expect(load.detail).toContain("adopters[0]");
  });

  it("calls an ARRAY adopter entry CORRUPT rather than accepting it", () => {
    expect(parseAdopterState('{"adopters":[[]]}', "f.json").kind).toBe("corrupt");
  });

  it("names the index of the bad entry, not just the file", () => {
    const load = parseAdopterState('{"adopters":[{"repo":"a/one"},null]}', "f.json");
    expect(load.kind).toBe("corrupt");
    if (load.kind === "corrupt") expect(load.detail).toContain("adopters[1]");
  });
});

describe("adopter state: unreadable is not the same as absent", () => {
  // Mutation that survived: reporting EVERY read error as `missing`. An absent
  // file is the benign pre-first-run state and the run continues on it, so
  // swallowing a permission error or a directory-where-a-file-should-be as
  // "missing" would render the wall from nothing and call it normal.
  it("THROWS when the path is a directory, rather than calling it missing", () => {
    const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
    expect(() => loadAdopterState(dir)).toThrow();
  });

  it("still calls a genuinely absent file MISSING", () => {
    expect(loadAdopterState("/nonexistent/adoption-data/adopters.json").kind).toBe("missing");
  });
});

describe("monogram letters are codepoints, not UTF-16 units", () => {
  // Mutation that survived: `name.trim()[0]` instead of `[...name.trim()][0]`.
  // Every existing case used a BMP character, where the two agree. An astral
  // codepoint is where they part: indexing yields a lone surrogate, which
  // renders as a replacement box on a customer-facing page.
  it("takes a whole astral codepoint, not half a surrogate pair", () => {
    expect(monogramLetter("🚀 Rocket Corp")).toBe("🚀");
    expect([...monogramLetter("🚀 Rocket Corp")]).toHaveLength(1);
  });

  it("does not split a surrogate pair when the name is padded", () => {
    expect(monogramLetter("  𝔄cme")).toBe("𝔄");
  });
});

describe("probeTargets skips what has no image to probe", () => {
  // Mutation that survived: none of the existing cases carried a monogram tile
  // or an empty logo, so the two filters that keep a probe from being fired at
  // an empty URL were never exercised.
  it("does not probe a monogram entry, which has no logo to fetch", () => {
    const next: WallEntry[] = [
      { ...entry("a/one"), logo: "", monogram: true },
      { ...entry("b/two"), logo: "https://x/u/2" },
    ];
    expect(probeTargets([], next)).toEqual([{ url: "https://x/u/2", repo: "b/two" }]);
  });

  it("does not probe a current tile whose logo is empty", () => {
    const current = [
      { repo: "a/one", name: "One", url: "u", logo: "" },
      { repo: "b/two", name: "Two", url: "u", logo: "https://x/u/2" },
    ];
    expect(probeTargets(current, null)).toEqual([{ url: "https://x/u/2", repo: "b/two" }]);
  });
});

describe("the REST fallback bounds nothing away: every repo is asked for", () => {
  // The GraphQL path pages; the REST path does not, and a repo it never asks
  // about is a repo that silently leaves the wall.
  it("issues one request per repo and resolves every one of them", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return new Response(
        JSON.stringify({ stargazers_count: 100, fork: false, owner: { id: 7 } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    try {
      const m = new Map<string, RepoMeta>();
      await fetchRepoMetaRest(["a/one", "b/two", "c/three"], m);
      expect(asked).toHaveLength(3);
      expect([...m.keys()]).toEqual(["a/one", "b/two", "c/three"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // EVERY field, one at a time. Dropping the whole payload as a single case
  // leaves each individual field check redundant with its neighbours, so any
  // one of them could be deleted with the suite still green — and a payload
  // missing only `owner.id` would render `avatars.githubusercontent.com/u/undefined`.
  it.each([
    ["stargazers_count", { fork: false, owner: { id: 7 } }],
    ["fork", { stargazers_count: 100, owner: { id: 7 } }],
    ["owner.id", { stargazers_count: 100, fork: false, owner: {} }],
    ["owner", { stargazers_count: 100, fork: false }],
  ])(
    "skips a REST payload missing %s rather than writing a half-filled RepoMeta",
    async (_field, payload) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      try {
        const m = new Map<string, RepoMeta>();
        await fetchRepoMetaRest(["a/one"], m);
        expect(m.size).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("treats a 451 takedown as a per-repo fact, not a reason to abort the run", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 451, statusText: "Gone" }));
    try {
      const m = new Map<string, RepoMeta>();
      await expect(fetchRepoMetaRest(["a/one"], m)).resolves.toBeUndefined();
      expect(m.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
