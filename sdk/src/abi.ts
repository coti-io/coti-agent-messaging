export const PRIVATE_AGENT_MESSAGING_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "epochDurationSeconds",
        type: "uint64",
        internalType: "uint64"
      }
    ],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "currentEpoch",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "fundEpoch",
    inputs: [
      {
        name: "epoch",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [],
    stateMutability: "payable"
  },
  {
    type: "function",
    name: "getEpochSummary",
    inputs: [
      {
        name: "epoch",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "totalMessages",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "rewardPool",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "claimedAmount",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "claimedUsage",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "pendingRewards",
    inputs: [
      {
        name: "epoch",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "agent",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "claimRewards",
    inputs: [
      {
        name: "epoch",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "sendMessage",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address"
      },
      {
        name: "encryptedMessage",
        type: "tuple",
        internalType: "struct itString",
        components: [
          {
            name: "ciphertext",
            type: "tuple",
            internalType: "struct ctString",
            components: [
              {
                name: "value",
                type: "uint256[]",
                internalType: "ctUint64[]"
              }
            ]
          },
          {
            name: "signature",
            type: "bytes[]",
            internalType: "bytes[]"
          }
        ]
      }
    ],
    outputs: [
      {
        name: "messageId",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "getMessage",
    inputs: [
      {
        name: "messageId",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "messageView",
        type: "tuple",
        internalType: "struct PrivateAgentMessaging.MessageView",
        components: [
          {
            name: "id",
            type: "uint256",
            internalType: "uint256"
          },
          {
            name: "from",
            type: "address",
            internalType: "address"
          },
          {
            name: "to",
            type: "address",
            internalType: "address"
          },
          {
            name: "timestamp",
            type: "uint64",
            internalType: "uint64"
          },
          {
            name: "epoch",
            type: "uint64",
            internalType: "uint64"
          },
          {
            name: "ciphertext",
            type: "tuple",
            internalType: "struct ctString",
            components: [
              {
                name: "value",
                type: "uint256[]",
                internalType: "ctUint64[]"
              }
            ]
          }
        ]
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "getMessageMetadata",
    inputs: [
      {
        name: "messageId",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "from",
        type: "address",
        internalType: "address"
      },
      {
        name: "to",
        type: "address",
        internalType: "address"
      },
      {
        name: "timestamp",
        type: "uint64",
        internalType: "uint64"
      },
      {
        name: "epoch",
        type: "uint64",
        internalType: "uint64"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "getInboxPage",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address"
      },
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "limit",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "messageIds",
        type: "uint256[]",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "getSentPage",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address"
      },
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256"
      },
      {
        name: "limit",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    outputs: [
      {
        name: "messageIds",
        type: "uint256[]",
        internalType: "uint256[]"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "inboxCount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "function",
    name: "sentCount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address"
      }
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256"
      }
    ],
    stateMutability: "view"
  },
  {
    type: "event",
    name: "MessageSent",
    inputs: [
      {
        name: "messageId",
        type: "uint256",
        indexed: true,
        internalType: "uint256"
      },
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address"
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address"
      },
      {
        name: "epoch",
        type: "uint256",
        indexed: false,
        internalType: "uint256"
      }
    ],
    anonymous: false
  }
] as const;
