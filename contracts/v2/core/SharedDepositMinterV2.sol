// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.20;

// v1 veth2 minter with some code removed
// user deposits eth to get minted token
// The contract cannot move user ETH outside unless
// 1. the user redeems 1:1
// 2. the depositToEth2 or depositToEth2Batch fns are called which allow moving ETH to the mainnet deposit contract only
// 3. The contract allows permissioned external actors to supply validator public keys
// 4. Who is allows to deposit how many validators is governed outside this contract
// 5. The ability to provision validators for user ETH is portioned out by the DAO
import {IvETH2} from "../../interfaces/IvETH2.sol";
import {IFeeCalc} from "../../interfaces/IFeeCalc.sol";
import {IERC20MintableBurnable} from "../../interfaces/IERC20MintableBurnable.sol";
import {IxERC4626} from "../../interfaces/IxERC4626.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ETH2DepositWithdrawalCredentials} from "../../lib/ETH2DepositWithdrawalCredentials.sol";

contract SharedDepositMinterV2 is Ownable, Pausable, ReentrancyGuard, ETH2DepositWithdrawalCredentials {
    using SafeMath for uint256;
    /* ========== STATE VARIABLES ========== */
    uint256 public adminFee;
    uint256 public numValidators;
    uint256 public costPerValidator;

    // The validator shares created by this shared stake contract. 1 share costs >= 1 eth
    uint256 public curValidatorShares; //initialized to 0

    // The number of times the deposit to eth2 contract has been called to create validators
    uint256 public validatorsCreated; //initialized to 0

    // Total accrued admin fee
    uint256 public adminFeeTotal; //initialized to 0

    // Its hard to exactly hit the max deposit amount with small shares. this allows a small bit of overflow room
    // Eth in the buffer cannot be withdrawn by an admin, only by burning the underlying token via a user withdraw
    uint256 public buffer;

    // Flash loan tokenomic protection in case of changes in admin fee with future lots
    bool public refundFeesOnWithdraw; //initialized to false

    address public LSDTokenAddress;
    IFeeCalc public FeeCalc;
    IERC20MintableBurnable public SGETH;
    IxERC4626 public WSGETH;

    constructor(
        uint256 _numValidators,
        uint256 _adminFee,
        address _feeCalculatorAddr,
        address _sgETHAddr,
        address _wsgETHAddr
    ) ETH2DepositWithdrawalCredentials() {
        FeeCalc = IFeeCalc(_feeCalculatorAddr);
        SGETH = IERC20MintableBurnable(_sgETHAddr);
        WSGETH = IxERC4626(_wsgETHAddr);

        uint256 MAX_INT = 2**256 - 1;
        SGETH.approve(_wsgETHAddr, MAX_INT); // max approve wsgeth for deposit and stake

        adminFee = _adminFee; // Admin and infra fees
        numValidators = _numValidators; // The number of validators to create in this lot. Sets a max limit on deposits

        // Eth in the buffer cannot be withdrawn by an admin, only by burning the underlying token
        buffer = uint256(10).mul(1e18); // roughly equal to 10 eth.

        LSDTokenAddress = _sgETHAddr;

        costPerValidator = uint256(32).mul(1e18).add(adminFee);
    }

    /*//////////////////////////////////////////////////////////////
                        DEPOSIT/WITHDRAWAL LOGIC
    //////////////////////////////////////////////////////////////*/

    // USER INTERACTIONS
    /*
        Shares minted = Z
        Principal deposit input = P
        AdminFee = a
        costPerValidator = 32 + a
        AdminFee as percent in 1e18 = a% =  (a / costPerValidator) * 1e18
        AdminFee on tx in 1e18 = (P * a% / 1e18)

        on deposit:
        P - (P * a%) = Z

        on withdraw with admin fee refund:
        P = Z / (1 - a%)
        P = Z - Z*a%
    */

    function deposit() external payable nonReentrant whenNotPaused {
        SGETH.mint(msg.sender, _depositAccounting());
    }

    function depositAndStake() external payable nonReentrant whenNotPaused {
        uint256 amt = _depositAccounting();
        SGETH.mint(address(this), amt);
        WSGETH.deposit(amt, msg.sender);
    }

    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        SGETH.burn(msg.sender, amount);
        uint256 assets = _withdrawAccounting(amount);

        address payable sender = payable(msg.sender);
        Address.sendValue(sender, assets);
    }

    function unstakeAndWithdraw(uint256 amount) external nonReentrant whenNotPaused {
        uint256 assets = WSGETH.redeem(amount, address(this), msg.sender);
        SGETH.burn(address(this), assets);
        assets = _withdrawAccounting(assets); // account for fees / update state

        address payable sender = payable(msg.sender);
        Address.sendValue(sender, assets);
    }

    // migration function to accept old monies and copy over state
    // users should not use this as it just donates the money without minting veth or tracking donations
    function donate(uint256 shares) external payable nonReentrant {}

    /*//////////////////////////////////////////////////////////////
                            ADMIN LOGIC
    //////////////////////////////////////////////////////////////*/

    // Used to migrate state over to new contract
    function migrateShares(uint256 shares) external onlyOwner nonReentrant {
        curValidatorShares = shares;
    }

    function batchDepositToEth2(
        bytes[] calldata pubkeys,
        bytes[] calldata signatures,
        bytes32[] calldata depositDataRoots
    ) external onlyOwner {
        require(address(this).balance >= _depositAmount, "Eth2Staker:depositToEth2: Not enough balance"); //need at least 32 ETH
        _batchDeposit(pubkeys, signatures, depositDataRoots);
        validatorsCreated = validatorsCreated.add(pubkeys.length);
    }

    function setFeeCalc(address _feeCalculatorAddr) external onlyOwner {
        FeeCalc = IFeeCalc(_feeCalculatorAddr);
    }

    function withdrawAdminFee(uint256 amount) external onlyOwner nonReentrant {
        address payable sender = payable(msg.sender);
        if (amount == 0) {
            amount = adminFeeTotal;
        }
        require(amount <= adminFeeTotal, "Eth2Staker:withdrawAdminFee: More than adminFeeTotal cannot be withdrawn");
        adminFeeTotal = adminFeeTotal.sub(amount);
        Address.sendValue(sender, amount);
    }

    function setNumValidators(uint256 _numValidators) external onlyOwner {
        require(_numValidators != 0, "Minimum 1 validator");
        numValidators = _numValidators;
    }

    function setWithdrawalCredential(bytes memory _new_withdrawal_pubkey) external onlyOwner {
        _setWithdrawalCredential(_new_withdrawal_pubkey);
    }

    /*//////////////////////////////////////////////////////////////
                            ACCOUNTING LOGIC
    //////////////////////////////////////////////////////////////*/

    function remainingSpaceInEpoch() external view returns (uint256) {
        // Helpful view function to gauge how much the user can send to the contract when it is near full
        uint256 remainingShares = (maxValidatorShares()).sub(curValidatorShares);
        uint256 valBeforeAdmin = remainingShares.mul(1e18).div(
            uint256(1).mul(1e18).sub(adminFee.mul(1e18).div(costPerValidator))
        );
        return valBeforeAdmin;
    }

    function maxValidatorShares() public view returns (uint256) {
        return uint256(32).mul(1e18).mul(numValidators);
    }

    function _depositAccounting() internal returns (uint256 value) {
        // input is whole, not / 1e18 , i.e. in 1 = 1 eth send when from etherscan
        value = msg.value;
        uint256 fee;

        if (address(FeeCalc) != address(0)) {
            (value, fee) = FeeCalc.processDeposit(value, msg.sender);
            adminFeeTotal = adminFeeTotal.add(fee);
        }

        uint256 newShareTotal = curValidatorShares.add(value);

        require(newShareTotal <= buffer.add(maxValidatorShares()), "_depositAccounting:Amt 2 lrg");
        curValidatorShares = newShareTotal;
    }

    function _withdrawAccounting(uint256 amount) internal returns (uint256) {
        uint256 fee;
        if (address(FeeCalc) != address(0)) {
            (amount, fee) = FeeCalc.processWithdraw(amount, msg.sender);
            if (refundFeesOnWithdraw) {
                adminFeeTotal = adminFeeTotal.sub(fee);
            } else {
                adminFeeTotal = adminFeeTotal.add(fee);
            }
        }

        require(
            address(this).balance >= amount.add(adminFeeTotal),
            "Eth2Staker:withdraw:Not enough balance in contract"
        );
        curValidatorShares = curValidatorShares.sub(amount);
        return amount;
    }
}
