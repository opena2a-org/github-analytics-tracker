/**
 * The series registry: the one place that names, scopes and defines each
 * headline series the tracker publishes.
 *
 * Consumed by scripts/generate-summary.js (summary.series.* metadata), the
 * overview API (pages/api/overview.js, `series` block) and the dashboard
 * (pages/index.js). Pages read labels from here; a label typed in a page is a
 * defect the regression test in test/series.test.js catches.
 *
 * Definitions are the producer's full sentences (CDE ruling 2026-08-25) and are
 * emitted verbatim into data/summary.json. The dated clauses inside them are
 * checked against the database's own first dates by the summary builder and
 * the regression test, never re-typed.
 */

const SCOPE_ALL = 'tracked-orgs';
const SCOPE_EX_CRYPTO = 'tracked-orgs-ex-cryptoserve';

// Sources each series sums. Used to attribute a collector error to the series
// it degrades (status "partial").
const DOWNLOAD_SOURCES = ['github', 'npm', 'pypi', 'docker', 'huggingface'];

const COLLECTED_SET =
  'everything the tracker collects (public non-fork repos in opena2a-org, ' +
  'opena2a-standards and ecolibria; npm packages by author ecolibria plus pinned; ' +
  'PyPI packages discovered from those repos plus pinned; Docker images under ' +
  'opena2a/; Hugging Face models by opena2a)';

const EX_CRYPTO_CLAUSE = 'excluding ecolibria/cryptoserve and the cryptoserve* packages';

const DOWNLOADS_TERMS =
  'npm downloads (daily rows since 2025-01-28), PyPI downloads without mirrors ' +
  '(daily rows since 2026-02-02; pypistats serves 180 days, earlier history ' +
  'unrecoverable), Docker Hub cumulative pulls, Hugging Face all-time downloads, ' +
  'and GitHub git clones (daily counts since 2025-10-24, summed as GitHub reports ' +
  'them, so automated CI, mirror and repeat clones each count) - not deduplicated ' +
  'across days, actors or sources; page views excluded.';

const ADOPTION_TERMS =
  'the same gross npm, PyPI, Docker Hub and Hugging Face terms plus GitHub\'s ' +
  'rolling 14-day distinct-cloner snapshot; a mixed-window sum in which only the ' +
  'clone term is deduplicated, and only within 14 days.';

const SERIES = {
  downloads: {
    key: 'downloads',
    label: 'downloads, pulls, and clones, counted per event',
    method: 'gross-sum',
    scope: SCOPE_ALL,
    includesCryptoServe: true,
    sources: DOWNLOAD_SOURCES,
    definition:
      `Gross download events summed across ${COLLECTED_SET}: ${DOWNLOADS_TERMS}`,
  },
  downloadsExCrypto: {
    key: 'downloadsExCrypto',
    label: 'downloads, pulls, and clones, counted per event, excluding CryptoServe',
    method: 'gross-sum',
    scope: SCOPE_EX_CRYPTO,
    includesCryptoServe: false,
    sources: DOWNLOAD_SOURCES,
    definition:
      `Gross download events summed across ${COLLECTED_SET}, ${EX_CRYPTO_CLAUSE}: ${DOWNLOADS_TERMS}`,
  },
  adoption: {
    key: 'adoption',
    label: 'package, image, and model download events plus current 14-day distinct cloners',
    method: 'mixed-window-sum',
    scope: SCOPE_ALL,
    includesCryptoServe: true,
    sources: DOWNLOAD_SOURCES,
    definition:
      `Package, image and model download events plus current 14-day distinct cloners: ${ADOPTION_TERMS}`,
  },
  adoptionExCrypto: {
    key: 'adoptionExCrypto',
    label: 'package, image, and model download events plus current 14-day distinct cloners, excluding CryptoServe',
    method: 'mixed-window-sum',
    scope: SCOPE_EX_CRYPTO,
    includesCryptoServe: false,
    sources: DOWNLOAD_SOURCES,
    definition:
      `Package, image and model download events plus current 14-day distinct cloners, ${EX_CRYPTO_CLAUSE}: ${ADOPTION_TERMS}`,
  },
};

const SERIES_KEYS = Object.keys(SERIES);

// The dated clauses the definitions carry, keyed by the source table they
// describe. The summary builder compares these to MIN(date) in the database so
// a definition can never silently disagree with the data it describes.
const DEFINITION_FIRST_DATES = {
  npm: '2025-01-28',
  pypi: '2026-02-02',
  clones: '2025-10-24',
};

module.exports = { SERIES, SERIES_KEYS, DEFINITION_FIRST_DATES, SCOPE_ALL, SCOPE_EX_CRYPTO };
