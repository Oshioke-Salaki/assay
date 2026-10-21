/** ABI fragments copied from the verified Celo mainnet implementations. */

export const identityRegistryAbi = [
  {
    type: "event",
    name: "Registered",
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "agentURI", type: "string" },
      { indexed: true, name: "owner", type: "address" },
    ],
  },
  {
    type: "event",
    name: "URIUpdated",
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: false, name: "newURI", type: "string" },
      { indexed: true, name: "updatedBy", type: "address" },
    ],
  },
  {
    type: "event",
    name: "MetadataSet",
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "indexedMetadataKey", type: "string" },
      { indexed: false, name: "metadataKey", type: "string" },
      { indexed: false, name: "metadataValue", type: "bytes" },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: true, name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
] as const;

export const reputationRegistryAbi = [
  {
    type: "event",
    name: "NewFeedback",
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "clientAddress", type: "address" },
      { indexed: false, name: "feedbackIndex", type: "uint64" },
      { indexed: false, name: "value", type: "int128" },
      { indexed: false, name: "valueDecimals", type: "uint8" },
      { indexed: true, name: "indexedTag1", type: "string" },
      { indexed: false, name: "tag1", type: "string" },
      { indexed: false, name: "tag2", type: "string" },
      { indexed: false, name: "endpoint", type: "string" },
      { indexed: false, name: "feedbackURI", type: "string" },
      { indexed: false, name: "feedbackHash", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "FeedbackRevoked",
    anonymous: false,
    inputs: [
      { indexed: true, name: "agentId", type: "uint256" },
      { indexed: true, name: "clientAddress", type: "address" },
      { indexed: true, name: "feedbackIndex", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "value", type: "int128" },
      { name: "valueDecimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "endpoint", type: "string" },
      { name: "feedbackURI", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getLastIndex",
    stateMutability: "view",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;

/** Read surface of Self's SelfAgentRegistry (github.com/selfxyz/self-agent-id, contracts/src/SelfAgentRegistry.sol). */
export const selfAgentRegistryAbi = [
  {
    type: "function",
    name: "agentKeyToAgentId",
    stateMutability: "view",
    inputs: [{ name: "k", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "hasHumanProof",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isProofFresh",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getHumanNullifier",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const erc20TransferEventAbi = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

export const authorizationUsedEventAbi = [
  {
    type: "event",
    name: "AuthorizationUsed",
    anonymous: false,
    inputs: [
      { indexed: true, name: "authorizer", type: "address" },
      { indexed: true, name: "nonce", type: "bytes32" },
    ],
  },
] as const;

export const celoAgentVisaAbi = [
  {
    type: "function",
    name: "getTier",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;
