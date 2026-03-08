import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("PrivateAgentMessaging", () => {
  async function deployFixture() {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("PrivateAgentMessagingHarness");
    const contract = await factory.deploy(14 * 24 * 60 * 60);

    const ct = (values: bigint[]) => ({ value: values });

    return { contract, owner, alice, bob, carol, ct };
  }

  it("records sent and inbox pages with viewer-specific ciphertext", async () => {
    const { contract, alice, bob, carol, ct } = await loadFixture(deployFixture);

    await contract.recordSyntheticMessage(
      alice.address,
      bob.address,
      ct([11n, 12n]),
      ct([21n, 22n]),
      ct([31n, 32n])
    );

    expect(await contract.sentCount(alice.address)).to.equal(1n);
    expect(await contract.inboxCount(bob.address)).to.equal(1n);
    expect(await contract.getSentPage(alice.address, 0, 10)).to.deep.equal([0n]);
    expect(await contract.getInboxPage(bob.address, 0, 10)).to.deep.equal([0n]);

    const senderView = await contract.connect(alice).getMessage(0);
    expect(senderView.from).to.equal(alice.address);
    expect(senderView.to).to.equal(bob.address);
    expect(senderView.ciphertext.value).to.deep.equal([21n, 22n]);

    const recipientView = await contract.connect(bob).getMessage(0);
    expect(recipientView.ciphertext.value).to.deep.equal([31n, 32n]);

    await expect(contract.connect(carol).getMessage(0)).to.be.revertedWithCustomError(
      contract,
      "UnauthorizedViewer"
    );
  });

  it("splits epoch rewards by message usage and gives final dust to the last claimant", async () => {
    const { contract, alice, bob, ct } = await loadFixture(deployFixture);

    await contract.fundEpoch(0, { value: 10n });

    await contract.recordSyntheticMessage(
      alice.address,
      bob.address,
      ct([1n]),
      ct([101n]),
      ct([201n])
    );
    await contract.recordSyntheticMessage(
      alice.address,
      bob.address,
      ct([2n]),
      ct([102n]),
      ct([202n])
    );
    await contract.recordSyntheticMessage(
      bob.address,
      alice.address,
      ct([3n]),
      ct([103n]),
      ct([203n])
    );

    await time.increase(14 * 24 * 60 * 60 + 1);

    expect(await contract.pendingRewards(0, alice.address)).to.equal(6n);
    expect(await contract.pendingRewards(0, bob.address)).to.equal(3n);

    await expect(() => contract.connect(alice).claimRewards(0)).to.changeEtherBalances(
      [alice, contract],
      [6n, -6n]
    );

    expect(await contract.pendingRewards(0, bob.address)).to.equal(4n);

    await expect(() => contract.connect(bob).claimRewards(0)).to.changeEtherBalances(
      [bob, contract],
      [4n, -4n]
    );

    const summary = await contract.getEpochSummary(0);
    expect(summary.claimedAmount).to.equal(10n);
    expect(summary.claimedUsage).to.equal(3n);
  });

  it("rejects active-epoch claims, double claims, and past-epoch funding", async () => {
    const { contract, alice, bob, ct } = await loadFixture(deployFixture);

    await contract.fundEpoch(0, { value: 9n });
    await contract.recordSyntheticMessage(
      alice.address,
      bob.address,
      ct([1n]),
      ct([2n]),
      ct([3n])
    );

    await expect(contract.connect(alice).claimRewards(0)).to.be.revertedWithCustomError(
      contract,
      "EpochStillActive"
    );

    await time.increase(14 * 24 * 60 * 60 + 1);

    await contract.connect(alice).claimRewards(0);

    await expect(contract.connect(alice).claimRewards(0)).to.be.revertedWithCustomError(
      contract,
      "AlreadyClaimed"
    );

    await expect(contract.fundEpoch(0, { value: 1n })).to.be.revertedWithCustomError(
      contract,
      "PastEpochFundingNotAllowed"
    );
  });
});
