import { expect } from "chai";
import { ethers, network } from "hardhat";

const ONE_DAY = 24 * 60 * 60;

type Stack = Awaited<ReturnType<typeof deployStack>>;

async function latestTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  return Number(block?.timestamp ?? 0);
}

async function increaseTime(seconds: number): Promise<void> {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function deployStack(votingPeriod = 60n) {
  const [deployer, treasury, user, voter] = await ethers.getSigners();

  const erc20Factory = await ethers.getContractFactory("ERC20Mock");
  const quoteToken: any = await erc20Factory.deploy("USD Coin", "USDC");
  await quoteToken.waitForDeployment();

  const uniFactoryFactory = await ethers.getContractFactory("UniswapV2Factory");
  const dexFactory: any = await uniFactoryFactory.deploy(deployer.address);
  await dexFactory.waitForDeployment();

  const routerFactory = await ethers.getContractFactory("WorkitDexRouter");
  const router: any = await routerFactory.deploy(await dexFactory.getAddress());
  await router.waitForDeployment();

  const workitFactory = await ethers.getContractFactory("WorkitToken");
  const workit: any = await workitFactory.deploy(deployer.address, treasury.address);
  await workit.waitForDeployment();

  const gTokenFactory = await ethers.getContractFactory("WorkitGToken");
  const gToken: any = await gTokenFactory.deploy(deployer.address, "");
  await gToken.waitForDeployment();

  const stakingFactory = await ethers.getContractFactory("WorkitStaking");
  const staking: any = await stakingFactory.deploy(
    deployer.address,
    await workit.getAddress(),
    await gToken.getAddress(),
    ethers.ZeroAddress,
    treasury.address,
  );
  await staking.waitForDeployment();

  const emissionFactory = await ethers.getContractFactory("WorkitEmissionManager");
  const emissionManager: any = await emissionFactory.deploy(
    deployer.address,
    await workit.getAddress(),
    await staking.getAddress(),
    treasury.address,
    ONE_DAY,
  );
  await emissionManager.waitForDeployment();

  const launchpadFactory = await ethers.getContractFactory("WorkitLaunchpad");
  const launchpad: any = await launchpadFactory.deploy(
    deployer.address,
    await workit.getAddress(),
    await router.getAddress(),
    await gToken.getAddress(),
    await staking.getAddress(),
  );
  await launchpad.waitForDeployment();

  const governanceFactory = await ethers.getContractFactory("WorkitGovernance");
  const governance: any = await governanceFactory.deploy(
    deployer.address,
    await workit.getAddress(),
    await launchpad.getAddress(),
    await staking.getAddress(),
    await emissionManager.getAddress(),
    votingPeriod,
  );
  await governance.waitForDeployment();

  const createRole = await dexFactory.CREATE_ROLE();
  await (await dexFactory.grantRole(createRole, await launchpad.getAddress())).wait();

  const workitMinterRole = await workit.MINTER_ROLE();
  await (await workit.grantRole(workitMinterRole, await emissionManager.getAddress())).wait();

  await (await workit.mint(user.address, ethers.parseEther("100000"))).wait();
  await (await workit.mint(deployer.address, ethers.parseEther("100000"))).wait();
  await (await workit.mint(voter.address, ethers.parseEther("100000"))).wait();

  await (await quoteToken.mint(user.address, ethers.parseEther("100000"))).wait();
  await (await quoteToken.mint(voter.address, ethers.parseEther("100000"))).wait();

  const poolManagerRole = await gToken.POOL_MANAGER_ROLE();
  const gTokenMinterRole = await gToken.MINTER_ROLE();
  await (await gToken.grantRole(poolManagerRole, await launchpad.getAddress())).wait();
  await (await gToken.grantRole(gTokenMinterRole, await launchpad.getAddress())).wait();

  const stakingPoolManagerRole = await staking.POOL_MANAGER_ROLE();
  await (await staking.grantRole(stakingPoolManagerRole, await launchpad.getAddress())).wait();
  await (await staking.grantRole(stakingPoolManagerRole, await governance.getAddress())).wait();
  await (await staking.setEmissionManager(await emissionManager.getAddress())).wait();

  const governanceRole = await launchpad.GOVERNANCE_ROLE();
  const finalizerRole = await launchpad.FINALIZER_ROLE();
  await (await launchpad.grantRole(governanceRole, await governance.getAddress())).wait();
  await (await launchpad.grantRole(finalizerRole, await governance.getAddress())).wait();

  const treasuryManagerRole = await emissionManager.TREASURY_MANAGER_ROLE();
  await (await emissionManager.grantRole(treasuryManagerRole, await governance.getAddress())).wait();

  return {
    deployer,
    treasury,
    user,
    voter,
    quoteToken,
    dexFactory,
    router,
    workit,
    gToken,
    staking,
    emissionManager,
    launchpad,
    governance,
  };
}

async function passProposal(stack: Stack, proposalId: bigint, voter?: string) {
  const signer = voter ? await ethers.getSigner(voter) : stack.deployer;
  await (await stack.governance.connect(signer).vote(proposalId, true)).wait();
  await increaseTime(70);
  await (await stack.governance.execute(proposalId)).wait();
}

async function setupCampaignWithGovernance(stack: Stack) {
  const quoteProposalId = (await stack.governance.proposalCount()) + 1n;
  await (
    await stack.governance.proposeQuoteTokenApproval(
      await stack.quoteToken.getAddress(),
      true,
      ethers.keccak256(ethers.toUtf8Bytes("approve quote")),
    )
  ).wait();
  await passProposal(stack, quoteProposalId);

  const latest = await latestTimestamp();
  const deadline = BigInt(latest + ONE_DAY);

  await (
    await stack.launchpad
      .connect(stack.user)
      .createCampaign(await stack.quoteToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"), deadline)
  ).wait();

  await (await stack.workit.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("2000"))).wait();
  await (await stack.quoteToken.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("2000"))).wait();

  await (
    await stack.launchpad.connect(stack.user).deposit(1, ethers.parseEther("1000"), ethers.parseEther("1000"))
  ).wait();
}

describe("WorkIt tokenomics", function () {
  it("Launchpad creates pool and adds liquidity", async function () {
    const stack = await deployStack();

    await (await stack.launchpad.setQuoteTokenAllowed(await stack.quoteToken.getAddress(), true)).wait();

    const deadline = BigInt((await latestTimestamp()) + ONE_DAY);
    await (
      await stack.launchpad
        .connect(stack.user)
        .createCampaign(await stack.quoteToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"), deadline)
    ).wait();

    await (await stack.workit.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.quoteToken.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.launchpad.connect(stack.user).deposit(1, ethers.parseEther("1000"), ethers.parseEther("1000"))).wait();

    await (await stack.launchpad.approveCampaign(1)).wait();
    await (await stack.launchpad.finalizeCampaign(1, 0, 0)).wait();

    const campaign = await stack.launchpad.campaigns(1);
    const pair = await stack.dexFactory.getPair(await stack.workit.getAddress(), await stack.quoteToken.getAddress());

    expect(campaign.pool).to.equal(pair);
    expect(campaign.liquidity).to.be.gt(0n);
    expect(await stack.launchpad.lpBalance(1)).to.equal(campaign.liquidity);
  });

  it("GToken id derivation is pool-keyed", async function () {
    const stack = await deployStack();
    await (await stack.launchpad.setQuoteTokenAllowed(await stack.quoteToken.getAddress(), true)).wait();

    const deadline = BigInt((await latestTimestamp()) + ONE_DAY);
    await (
      await stack.launchpad
        .connect(stack.user)
        .createCampaign(await stack.quoteToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"), deadline)
    ).wait();
    await (await stack.workit.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.quoteToken.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.launchpad.connect(stack.user).deposit(1, ethers.parseEther("1000"), ethers.parseEther("1000"))).wait();

    await (await stack.launchpad.approveCampaign(1)).wait();
    await (await stack.launchpad.finalizeCampaign(1, 0, 0)).wait();

    const campaign = await stack.launchpad.campaigns(1);
    const network = await ethers.provider.getNetwork();
    const expectedTokenId = BigInt(
      ethers.keccak256(ethers.solidityPacked(["uint256", "address"], [network.chainId, campaign.pool])),
    );

    expect(campaign.gTokenId).to.equal(expectedTokenId);
    expect(await stack.gToken.tokenIdForPool(campaign.pool)).to.equal(expectedTokenId);
    expect(await stack.gToken.poolForToken(expectedTokenId)).to.equal(campaign.pool);
  });

  it("GToken mint amount matches WORKIT provided at liquidity add", async function () {
    const stack = await deployStack();
    await (await stack.launchpad.setQuoteTokenAllowed(await stack.quoteToken.getAddress(), true)).wait();

    const deadline = BigInt((await latestTimestamp()) + ONE_DAY);
    await (
      await stack.launchpad
        .connect(stack.user)
        .createCampaign(await stack.quoteToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"), deadline)
    ).wait();
    await (await stack.workit.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.quoteToken.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.launchpad.connect(stack.user).deposit(1, ethers.parseEther("1000"), ethers.parseEther("1000"))).wait();

    await (await stack.launchpad.approveCampaign(1)).wait();
    await (await stack.launchpad.finalizeCampaign(1, 0, 0)).wait();

    const campaign = await stack.launchpad.campaigns(1);
    await (await stack.launchpad.connect(stack.user).claim(1, stack.user.address)).wait();

    const userGTokenBalance = await stack.gToken.balanceOf(stack.user.address, campaign.gTokenId);
    expect(userGTokenBalance).to.equal(campaign.workitUsed);
  });

  it("Stake -> accrue -> claimRewards works", async function () {
    const stack = await deployStack();
    await (await stack.launchpad.setQuoteTokenAllowed(await stack.quoteToken.getAddress(), true)).wait();

    const deadline = BigInt((await latestTimestamp()) + ONE_DAY);
    await (
      await stack.launchpad
        .connect(stack.user)
        .createCampaign(await stack.quoteToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"), deadline)
    ).wait();
    await (await stack.workit.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.quoteToken.connect(stack.user).approve(await stack.launchpad.getAddress(), ethers.parseEther("1000"))).wait();
    await (await stack.launchpad.connect(stack.user).deposit(1, ethers.parseEther("1000"), ethers.parseEther("1000"))).wait();

    await (await stack.launchpad.approveCampaign(1)).wait();
    await (await stack.launchpad.finalizeCampaign(1, 0, 0)).wait();

    const campaign = await stack.launchpad.campaigns(1);
    await (await stack.launchpad.connect(stack.user).claim(1, stack.user.address)).wait();

    const tokenId = campaign.gTokenId;
    await (await stack.gToken.connect(stack.user).setApprovalForAll(await stack.staking.getAddress(), true)).wait();
    await (await stack.staking.connect(stack.user).stake(tokenId, ethers.parseEther("1000"))).wait();

    await increaseTime(3 * ONE_DAY);

    const workitBefore = await stack.workit.balanceOf(stack.user.address);
    await (await stack.staking.connect(stack.user).claimRewards([tokenId], stack.user.address)).wait();
    const workitAfter = await stack.workit.balanceOf(stack.user.address);

    expect(workitAfter).to.be.gt(workitBefore);

    await (await stack.staking.connect(stack.user).withdraw(tokenId, ethers.parseEther("1000"), stack.user.address)).wait();
    expect(await stack.gToken.balanceOf(stack.user.address, tokenId)).to.equal(ethers.parseEther("1000"));
  });

  it("Governance can approve campaign and set emissions", async function () {
    const stack = await deployStack();
    await setupCampaignWithGovernance(stack);

    const finalizeProposalId = (await stack.governance.proposalCount()) + 1n;
    await (
      await stack.governance.proposeCampaignFinalization(
        1,
        0,
        0,
        ethers.keccak256(ethers.toUtf8Bytes("finalize campaign")),
      )
    ).wait();
    await passProposal(stack, finalizeProposalId);

    const campaign = await stack.launchpad.campaigns(1);

    const emissionProposalId = (await stack.governance.proposalCount()) + 1n;
    await (
      await stack.governance.proposePoolEmissionWeight(
        campaign.pool,
        ethers.parseEther("2"),
        ethers.keccak256(ethers.toUtf8Bytes("set emission")),
      )
    ).wait();
    await passProposal(stack, emissionProposalId);

    const poolInfo = await stack.staking.pools(campaign.gTokenId);
    expect(poolInfo.emissionWeight).to.equal(ethers.parseEther("2"));
  });

  it("End-to-end: campaign, pool, gtoken, stake, rewards, withdraw", async function () {
    const stack = await deployStack();
    await setupCampaignWithGovernance(stack);

    const finalizeProposalId = (await stack.governance.proposalCount()) + 1n;
    await (
      await stack.governance.proposeCampaignFinalization(
        1,
        0,
        0,
        ethers.keccak256(ethers.toUtf8Bytes("finalize campaign end-to-end")),
      )
    ).wait();
    await passProposal(stack, finalizeProposalId);

    const campaign = await stack.launchpad.campaigns(1);
    expect(campaign.pool).to.not.equal(ethers.ZeroAddress);
    expect(campaign.gTokenId).to.not.equal(0n);

    await (await stack.launchpad.connect(stack.user).claim(1, stack.user.address)).wait();
    const tokenId = campaign.gTokenId;

    expect(await stack.gToken.balanceOf(stack.user.address, tokenId)).to.equal(campaign.workitUsed);

    await (await stack.gToken.connect(stack.user).setApprovalForAll(await stack.staking.getAddress(), true)).wait();
    await (await stack.staking.connect(stack.user).stake(tokenId, campaign.workitUsed)).wait();

    await increaseTime(4 * ONE_DAY);

    const beforeClaim = await stack.workit.balanceOf(stack.user.address);
    await (await stack.staking.connect(stack.user).claimRewards([tokenId], stack.user.address)).wait();
    const afterClaim = await stack.workit.balanceOf(stack.user.address);
    expect(afterClaim).to.be.gt(beforeClaim);

    await (await stack.staking.connect(stack.user).withdraw(tokenId, campaign.workitUsed, stack.user.address)).wait();

    expect(await stack.gToken.balanceOf(stack.user.address, tokenId)).to.equal(campaign.workitUsed);
  });
});
