export const DEFAULT_MAX_FIRST_REPLIES_PER_SUBREDDIT_PER_DAY = 2;
export const DEFAULT_MAX_FIRST_REPLIES_GLOBAL_PER_DAY = 8;
export const SIMILARITY_BLOCK_THRESHOLD = 0.58;
export const SAME_THREAD_SIMILARITY_BLOCK_THRESHOLD = 0.48;
export const THREAD_COMMENT_SIMILARITY_BLOCK_THRESHOLD = 0.55;

export const EXPLICIT_HELP_PATTERNS = [
  /\bhow (?:do|would|can|should|to)\b/i,
  /\bwhat (?:is|are|would|should|can)\b/i,
  /\bwhy (?:is|are|would|does|do)\b/i,
  /\bany (?:advice|recommendations?|tools?|examples?|ideas?)\b/i,
  /\blooking for\b/i,
  /\btrying to\b/i,
  /\bstruggling with\b/i,
  /\bneed (?:a|an|some|help)\b/i
] as const;

export const RHETORICAL_TITLE_PATTERNS = [
  /^anyone else\b/i,
  /^am i the only one\b/i,
  /^is it just me\b/i,
  /^does anyone else\b/i,
  /^who else\b/i
] as const;

export const DISCOVERY_MIN_RELEVANCE_SCORE = 6;

export const AGENT_MESSAGING_TOPIC_PATTERNS = [
  /\bai agents?\b/i,
  /\bmcp\b/i,
  /\blangchain\b/i,
  /\bollama\b/i,
  /\bautogen\b/i,
  /\bcrewai\b/i,
  /\bagentic\b/i,
  /\bprivate (?:message|messaging|channel|inbox)\b/i,
  /\bagent(?:s)?\s+(?:coordination|communication|messaging)\b/i,
  /\bagent(?:-|\s)?to(?:-|\s)?agent\b/i,
  /\bencrypted?(?:\s+)?(?:message|messaging|channel)\b/i,
  /\bagent(?:s)?\s+sdk\b/i,
  /\bllm agents?\b/i,
  /\bmulti[- ]?agent\b/i,
  /\btool[- ]?call(?:ing)?\b/i,
  /\bfunction[- ]?call(?:ing)?\b/i,
  /\borchestrat(?:e|ion|ing)\b/i,
  /\bopenai api\b/i,
  /\bwebhook\b/i,
  /\bmessage queue\b/i,
  /\b(?:^|\s)rag(?:\s|$)/i
] as const;

export const SUBSTANTIVE_DISCUSSION_PATTERNS = [
  /\b(?:building|built|implement(?:ed|ing)?|integrat(?:ed|ing)?|deploy(?:ed|ing)?)\b/i,
  /\b(?:architecture|approach|pattern|workflow|stack)\b/i,
  /\b(?:looking at|evaluating|comparing|switching to)\b/i
] as const;

export const LOW_INTENT_PATTERNS = [
  /\bairdrop\b/i,
  /\bgiveaway\b/i,
  /\bprice\b/i,
  /\bmoon\b/i,
  /\bshill\b/i,
  /\breferral\b/i,
  /\bpromo(?:tion)?\b/i
] as const;
export const OPERATIONAL_PAIN_PATTERNS = [
  /\bbroken\b/i,
  /\bmanual\b/i,
  /\bspreadsheet\b/i,
  /\bcrm\b/i,
  /\bfailing\b/i,
  /\bincident\b/i,
  /\bmessy\b/i,
  /\bworkflow\b/i,
  /\bhand[- ]?off\b/i,
  /\bduplicate(?:d)?\b/i,
  /\bdata quality\b/i,
  /\bops?\b/i,
  /\bon[- ]?call\b/i,
  /\bdebug\b/i
] as const;
export const ARGUMENT_OR_HOSTILITY_PATTERNS = [
  /\bidiot\b/i,
  /\bstupid\b/i,
  /\bshill\b/i,
  /\bastroturf\b/i,
  /\bflame(?:war)?\b/i,
  /\bfight me\b/i,
  /\bunpopular opinion\b/i,
  /\bchange my mind\b/i
] as const;
export const PRODUCT_INTEREST_PATTERNS = [
  /\b(?:what|which|any)\s+(?:tool|tools|product|products|sdk|library|framework|service)\b/i,
  /\brecommend(?:ation)?s?\b.{0,24}\b(?:tool|sdk|library|service)\b/i,
  /\bwhat do you use\b/i,
  /\banybody using\b/i,
  /\bbuild vs buy\b/i
] as const;

export const CTA_PATTERNS = [
  /\b(?:dm|pm) me\b/i,
  /\bmessage me\b/i,
  /\bcheck (?:out )?(?:my|our)\b/i,
  /\bvisit (?:my|our)\b/i,
  /\bsign up\b/i,
  /\bbook (?:a )?(?:demo|call)\b/i,
  /\bjoin (?:our|my)\b/i
] as const;
const PRIVATE_MESSAGE_PROMPT_PATTERNS = [/\b(?:dm|pm) me\b/i, /\bmessage me\b/i] as const;

export const URL_PATTERN = /https?:\/\/|www\./i;
