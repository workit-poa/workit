import { ethers } from "hardhat";

async function main() {
  const [deployer, treasurySigner] = await ethers.getSigners();

  const admin = deployer.address;
  const treasury = treasurySigner.address;

  const erc20Factory = await ethers.getContractFactory("ERC20Mock");
  const quoteToken = await erc20Factory.deploy("USD Coin", "USDC");
  await quoteToken.waitForDeployment();

  const uniswapFactoryFactory = await ethers.getContractFactory("UniswapV2Factory");
  const dexFactory = await uniswapFactoryFactory.deploy(admin);
  await dexFactory.waitForDeployment();

  const routerFactory = await ethers.getContractFactory("WorkitDexRouter");
  const router = await routerFactory.deploy(await dexFactory.getAddress());
  await router.waitForDeployment();

  const workitTokenFactory = await ethers.getContractFactory("WorkitToken");
  const workit = await workitTokenFactory.deploy(admin, treasury);
  await workit.waitForDeployment();

  const gTokenFactory = await ethers.getContractFactory("WorkitGToken");
  const gToken = await gTokenFactory.deploy(admin, "");
  await gToken.waitForDeployment();

  const stakingFactory = await ethers.getContractFactory("WorkitStaking");
  const staking = await stakingFactory.deploy(
    admin,
    await workit.getAddress(),
    await gToken.getAddress(),
    ethers.ZeroAddress,
    treasury,
  );
  await staking.waitForDeployment();

  const emissionFactory = await ethers.getContractFactory("WorkitEmissionManager");
  const emissionManager = await emissionFactory.deploy(
    admin,
    await workit.getAddress(),
    await staking.getAddress(),
    treasury,
    24 * 60 * 60,
  );
  await emissionManager.waitForDeployment();

  const launchpadFactory = await ethers.getContractFactory("WorkitLaunchpad");
  const launchpad = await launchpadFactory.deploy(
    admin,
    await workit.getAddress(),
    await router.getAddress(),
    await gToken.getAddress(),
    await staking.getAddress(),
  );
  await launchpad.waitForDeployment();

  const governanceFactory = await ethers.getContractFactory("WorkitGovernance");
  const governance = await governanceFactory.deploy(
    admin,
    await workit.getAddress(),
    await launchpad.getAddress(),
    await staking.getAddress(),
    await emissionManager.getAddress(),
    24 * 60 * 60,
  );
  await governance.waitForDeployment();

  const createRole = await dexFactory.CREATE_ROLE();
  await (await dexFactory.grantRole(createRole, await launchpad.getAddress())).wait();

  const workitMinterRole = await workit.MINTER_ROLE();
  await (await workit.grantRole(workitMinterRole, await emissionManager.getAddress())).wait();

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

  await (await launchpad.setQuoteTokenAllowed(await quoteToken.getAddress(), true)).wait();

  console.log("WorkIt stack deployed");
  console.log({
    deployer: admin,
    treasury,
    workit: await workit.getAddress(),
    gToken: await gToken.getAddress(),
    launchpad: await launchpad.getAddress(),
    staking: await staking.getAddress(),
    emissionManager: await emissionManager.getAddress(),
    governance: await governance.getAddress(),
    dexFactory: await dexFactory.getAddress(),
    router: await router.getAddress(),
    quoteToken: await quoteToken.getAddress(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
