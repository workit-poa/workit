# SaucerSwap Vendor Repos

This directory contains Git submodules for direct SaucerSwap contract usage:

- `saucerswap-core` -> `https://github.com/saucerswaplabs/saucerswaplabs-core`
- `saucerswap-periphery` -> `https://github.com/saucerswaplabs/saucerswap-periphery`

## Initialize submodules

From repo root:

```bash
git submodule update --init --recursive
```

## Import examples

From contracts under `libs/contracts/contracts/`:

```solidity
import {IUniswapV2Factory} from "../../vendor/saucerswap-core/contracts/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Router02} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Router02.sol";
```

Or from tests under `libs/contracts/test/`:

```solidity
import "../vendor/saucerswap-core/contracts/UniswapV2Factory.sol";
```

Hardhat is configured with Solidity `0.6.12` and `0.8.28` so SaucerSwap and project contracts can compile together when imported.
