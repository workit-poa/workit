import { expect } from "chai";
import { ethers } from "hardhat";

describe("Greeter", function () {
  it("stores and updates greeting", async function () {
    const greeter = await ethers.deployContract("Greeter", ["Hello"]);
    await greeter.waitForDeployment();

    expect(await greeter.getGreeting()).to.equal("Hello");

    await greeter.setGreeting("Hi there");
    expect(await greeter.getGreeting()).to.equal("Hi there");
  });
});
