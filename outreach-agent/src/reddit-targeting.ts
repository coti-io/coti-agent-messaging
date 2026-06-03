import type { RedditOutreachTargeting } from "./reddit-outreach-types.js";

export const DEFAULT_REDDIT_TARGETING: RedditOutreachTargeting = {
  productName: "COTI agent private messaging",
  targetAudience:
    "developers and operators building AI agents, MCP tools, wallet-backed automation, and privacy-sensitive agent coordination flows",
  productAliases: [
    "coti",
    "coti-agent-messaging",
    "coti agent messaging",
    "coti private messaging",
    "web4"
  ],
  targetSubreddits: [
    {
      name: "AI_Agents",
      audience: "agent builders and operators",
      rationale: "Direct fit for agent coordination, tool use, and autonomous workflows.",
      priority: "primary"
    },
    {
      name: "LocalLLaMA",
      audience: "hands-on AI builders",
      rationale: "Good fit when threads discuss agent runtimes, tools, and local orchestration.",
      priority: "primary"
    },
    {
      name: "LangChain",
      audience: "agent framework developers",
      rationale: "Relevant for MCP/tooling questions and agent communication patterns.",
      priority: "primary"
    },
    {
      name: "MachineLearning",
      audience: "technical ML community",
      rationale: "Only viable for architecture-level agent infrastructure discussions.",
      priority: "secondary"
    },
    {
      name: "ArtificialInteligence",
      audience: "general AI practitioners",
      rationale: "Broad but useful for agent coordination and privacy questions.",
      priority: "secondary"
    },
    {
      name: "ethdev",
      audience: "Ethereum and wallet-backed app developers",
      rationale: "Relevant when threads discuss wallet signing, onchain messaging, or privacy.",
      priority: "primary"
    },
    {
      name: "solidity",
      audience: "smart contract developers",
      rationale: "Useful for contract-level privacy, metadata, and reward-accounting discussions.",
      priority: "secondary"
    },
    {
      name: "web3",
      audience: "web3 builders",
      rationale: "Relevant only for technical privacy and agent-use cases, not token promotion.",
      priority: "secondary"
    },
    {
      name: "CryptoTechnology",
      audience: "technical crypto readers",
      rationale: "Better fit than trading subreddits for privacy and infrastructure explanations.",
      priority: "primary"
    },
    {
      name: "privacy",
      audience: "privacy-focused technical users",
      rationale: "Relevant when discussion is about encrypted communication tradeoffs.",
      priority: "experimental"
    },
    {
      name: "selfhosted",
      audience: "operators of private infrastructure",
      rationale: "Possible fit for agent messaging architecture, but avoid web3 framing unless asked.",
      priority: "experimental"
    },
    {
      name: "devops",
      audience: "infrastructure operators",
      rationale: "Only viable for operational coordination and automation reliability threads.",
      priority: "experimental"
    },
    {
      name: "mcp",
      audience: "MCP tool builders",
      rationale: "Direct fit if the community is active and rules allow technical answers.",
      priority: "primary"
    }
  ]
};

/** Full discovery pool (~50). Sampled per heartbeat via OUTREACH_REDDIT_DISCOVERY_SUBS_PER_RUN. */
export const DEFAULT_REDDIT_DISCOVERY_POOL: readonly string[] = [
  "AI_Agents",
  "LocalLLaMA",
  "LangChain",
  "mcp",
  "AutoGPT",
  "LLMDevs",
  "PromptEngineering",
  "ChatGPTCoding",
  "OpenAI",
  "singularity",
  "ArtificialInteligence",
  "MachineLearning",
  "learnmachinelearning",
  "programming",
  "softwareengineering",
  "devops",
  "selfhosted",
  "homelab",
  "kubernetes",
  "docker",
  "node",
  "typescript",
  "python",
  "golang",
  "rust",
  "SideProject",
  "SaaS",
  "indiehackers",
  "startups",
  "ethdev",
  "solidity",
  "ethereum",
  "web3",
  "CryptoTechnology",
  "defi",
  "0xProject",
  "privacy",
  "cryptography",
  "netsec",
  "compsci",
  "datascience",
  "sysadmin",
  "distributedsystems",
  "n8n",
  "automation",
  "Rag",
  "ollama",
  "ClaudeAI",
  "cursor",
  "agents",
  "buildinpublic",
  "Entrepreneur"
] as const;

/** Primary agent-messaging subs used when OUTREACH_REDDIT_TARGET_SUBREDDITS is unset. */
export function getDefaultRedditDiscoverySubredditNames(
  targeting: RedditOutreachTargeting = DEFAULT_REDDIT_TARGETING
): string[] {
  return targeting.targetSubreddits
    .filter((entry) => entry.priority === "primary")
    .map((entry) => entry.name);
}
