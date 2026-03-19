// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// Compile anchor for OpenZeppelin proxy artifacts used by scripts/tests.
contract OpenZeppelinProxyContracts {
    function touch(
        UpgradeableBeacon beacon,
        BeaconProxy beaconProxy,
        ERC1967Proxy erc1967Proxy
    ) external pure returns (bool) {
        return
            address(beacon) != address(0) ||
            address(beaconProxy) != address(0) ||
            address(erc1967Proxy) != address(0);
    }
}
