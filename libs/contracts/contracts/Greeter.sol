// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Greeter {
    string private greeting;

    constructor(string memory initialGreeting) {
        greeting = initialGreeting;
    }

    function setGreeting(string memory newGreeting) external {
        greeting = newGreeting;
    }

    function getGreeting() external view returns (string memory) {
        return greeting;
    }
}
