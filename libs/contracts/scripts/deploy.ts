import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Deploying with account: ${deployer.address}`);
  console.log(`Network chainId: ${network.chainId}`);

  const greeter = await ethers.deployContract("Greeter", ["Hello from Workit"]);
  await greeter.waitForDeployment();

  const address = await greeter.getAddress();
  const txHash = greeter.deploymentTransaction()?.hash;
  if (txHash) {
    console.log(`Deployment tx: ${txHash}`);
  }
  console.log(`Greeter deployed to: ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
