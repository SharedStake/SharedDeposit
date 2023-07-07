const hre = require("hardhat");
const fs = require("fs");
const {ethers} = hre;

const log = txt => {
  txt = txt + "  \n";
  console.log(txt);
  fs.writeFileSync("log.txt", txt, {flag: "a"});
};

const isMainnet = launchNetwork => {
  // some behaviours need to be tested with a mainnet fork which behaves the same as mainnet
  return launchNetwork == "localhost" || launchNetwork == "mainnet";
};
const notLocal = launchNetwork => launchNetwork !== 'localhost';
const wait = async ms => await new Promise(resolve => setTimeout(resolve, ms));
const printOverrides = o => {
  return {
    type: 2,
    maxFeePerGas: o.maxFeePerGas.toString(),
    maxPriorityFeePerGas: o.maxPriorityFeePerGas.toString(),
    gasLimit: o.gasLimit,
  };
};
const _getOverrides = async () => {

  const overridesForEIP1559 = {
    type: 2,
    maxFeePerGas: ethers.utils.parseUnits("20", "gwei"),
    maxPriorityFeePerGas: ethers.utils.parseUnits("1", "gwei"),
    gasLimit: 10000000,
  };
  // const gasPrice = await hre.ethers.provider.getGasPrice();
  // overridesForEIP1559.maxFeePerGas = gasPrice;

  let gas = await hre.ethers.provider.getFeeData();
  overridesForEIP1559.maxPriorityFeePerGas = gas.maxPriorityFeePerGas;
  overridesForEIP1559.maxFeePerGas = gas.maxFeePerGas;

  return overridesForEIP1559;
};

const _verifyBase = async (contract, launchNetwork, cArgs) => {
  try {
    await hre.run("verify:verify", {
      address: contract.address,
      constructorArguments: cArgs,
      network: launchNetwork,
    });
    log(`Verified ${JSON.stringify(contract)} on network: ${launchNetwork} with constructor args ${cArgs.join(", ")}`);
    log("\n");
    return true;
  } catch (e) {
    log(`Etherscan verification failed w/ ${e} | Args: ${cArgs} | on ${launchNetwork} for ${contract.address}`);
    return false;
  }
};

const _verify = async (contract, launchNetwork, cArgs) => {
  if (!launchNetwork || launchNetwork == "hardhat") return;
  await new Promise(resolve => setTimeout(resolve, 10000));
  await _verifyBase(contract, launchNetwork, cArgs);
};

const _deployContract = async (name, launchNetwork = false, cArgs = []) => {
  const overridesForEIP1559 = await _getOverrides();
  const factory = await hre.ethers.getContractFactory(name);
  const contract = await factory.deploy(...cArgs, overridesForEIP1559);
  await contract.deployTransaction.wait(1);
  await contract.deployed();
  log(`\nDeployed ${name} to ${contract.address} on ${launchNetwork}`);
  return Promise.resolve({contract: contract, args: cArgs, initialized: false, srcName: name});
};

function chunkArray(array, size) {
  if (array.length <= size) {
    return [array];
  }
  return [array.slice(0, size), ...chunkArray(array.slice(size), size)];
}

const _verifyAll = async (allContracts, launchNetwork) => {
  log("starting verifyall");
  if (!launchNetwork || launchNetwork == "hardhat" || launchNetwork == "localhost") return;
  let num = 60000; // 60s
  log(`Waiting ${num} ms to make sure everything has propagated on etherscan`);
  await wait(num);
  // wait 10s to make sure everything has propagated on etherscan

  let contractArr = [],
    verifyAttemtLog = {};
  Object.keys(allContracts).forEach(k => {
    let obj = allContracts[k];
    let contractMin = {
      address: obj.contract.address,
      args: obj.args,
      initialized: obj.initialized,
      name: k,
    };
    contractArr.push(contractMin);
    verifyAttemtLog[k] = contractMin;
  });

  contractArr = chunkArray(contractArr, 5);
  let verificationsPassed = 0;
  let verificationsFailed = 0;

  for (const arr of contractArr) {
    await Promise.all(
      arr.map(async contract => {
        log(`Verifying ${JSON.stringify(contract)} at ${contract.address} `);
        let res = await _verifyBase(contract, launchNetwork, contract.initialized ? [] : contract.args);
        res ? verificationsPassed++ : verificationsFailed++;
        verifyAttemtLog[contract.name].verifified = res;
      }),
    );
    log("Waiting 2 s for Etherscan API limit of 5 calls/s");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  fs.writeFileSync("verify_attempt_log.json", JSON.stringify(verifyAttemtLog));
  log(`Verifications finished: ${verificationsPassed} / ${verificationsFailed + verificationsPassed} `);
};

const _deployInitializableContract = async (name, launchNetwork = false, initArgs = []) => {
  const overridesForEIP1559 = await _getOverrides();
  const {contract, _} = await _deployContract(name, launchNetwork, []);
  if (initArgs.length > 0) {
    await contract.initialize(...initArgs, overridesForEIP1559);
  } else {
    await contract.initialize(initArgs, overridesForEIP1559);
  }
  log(`Initialized ${name} with ${initArgs.toString()} \n`);
  return Promise.resolve({contract: contract, args: initArgs, initialized: true, srcName: name});
};

const _getAddress = obj => {
  return obj == undefined || obj.contract == undefined
    ? "0x0000000000000000000000000000000000000000"
    : obj.contract.address;
};

const _postRun = (contracts, launchNetwork) => {
  log("\n\nDeployment finished. Contracts deployed: \n\n");
  let prefix = "https://";
  if (!isMainnet(launchNetwork)) {
    prefix += `${launchNetwork}.`;
  }
  prefix += "etherscan.io/address/";

  Object.keys(contracts).map(k => {
    let url = prefix + contracts[k].contract.address;
    log(`${k} deployed to ${contracts[k].contract.address} at ${url} `);
  });
  fs.writeFileSync("deploy_log.json", JSON.stringify(contracts), {flag: "a"});
};

const _sendTokens = async (contract, name, to, amount) => {
  let res = await _transact(contract.transfer, to, amount);
  log(`Tokens transferred: From ${contract.address} to ${name} at ${to} : ${amount}`);
  return res;
};

const _transferOwnership = async (name, contract, to) => {
  let res = await _transact(contract.transferOwnership, to);
  log(`Ownership transferred for ${name} at ${contract.address} to ${to}`);
  return res;
};

const _transact = async (tx, ...args) => {
  let overrides = await _getOverrides();
  let trace = await tx(...args, overrides);
  await trace.wait(); // throws on tx failure
  return trace;
};

const _getContract = (contracts, name) => {
  return contracts[name].contract;
};

async function advanceTimeAndBlock(time, ethers) {
  await advanceTime(time, ethers);
  await advanceBlock(ethers);
}

async function advanceTime(time, ethers) {
  await ethers.provider.send("evm_increaseTime", [time]);
}

async function advanceBlock(ethers) {
  await ethers.provider.send("evm_mine");
}

class DeployHelper {
  constructor(launchNetwork, multisig_address) {
    this.contracts = {};
    this.launchNetwork = launchNetwork;
    this.initialBalance = 0;
    this.currentBlockTime = 0;
    this.distribution = {};
    this.multisig_address = multisig_address;
  }
  async init(address, deployer = {}) {
    this.address = address;
    this.hre = hre;
    this.initialBalance = await hre.ethers.provider.getBalance(address);
    this.currentBlockTime = (await hre.ethers.provider.getBlock()).timestamp;
    this.deployer = deployer;
    this.gas = await hre.ethers.provider.getFeeData();
    // await hre.ethers.provider.getMaxFeePerGas();
    // 1500000016
    // 20000000000
    // console.log(this.gas, this.gas.maxFeePerGas.toString(), ethers.utils.parseUnits("20", "gwei").toString());
    // return;

    log(
      `Initial balance of deployer at ${this.address} is: ${this.initialBalance?.toString()} at block timestamp : ${
        this.currentBlockTime
      } on network: ${this.launchNetwork}`,
    );
  }
  async deployContract(name, ctrctName, args) {
    this.contracts[name] = await _deployContract(ctrctName, this.launchNetwork, args);
  }
  async deployInitializableContract(name, ctrctName, args) {
    this.contracts[name] = await _deployInitializableContract(ctrctName, this.launchNetwork, args);
  }
  addressOf(name) {
    return _getAddress(this.contracts[name]);
  }
  getContract(name) {
    return _getContract(this.contracts, name);
  }
  async getOverrides() {
    return await _getOverrides();
  }
  async transact(tx, ...args) {
    return await _transact(tx, args);
  }

  // Token distro
  addDist(name, amount) {
    this.distribution[name] = amount;
  }
  getContract(name) {
    return _getContract(this.contracts, name);
  }
  async getContractAt(name, address) {
    let factory = await hre.ethers.getContractFactory(name);
    let contract = await factory.attach(address);
    if (this.deployer?.address) await contract.connect(this.deployer);
    // this.contracts[name] = contract;
    return contract;
  }
  async _checkEnoughTokensToDistribute(token) {
    let total = Object.values(this.distribution).reduce((a, b) => a.add(b));
    let diff = (await this.getContract(token).balanceOf(this.address)).sub(total);
    if (diff !== 0) {
      log(`Distribution difference: ${diff.toString()}`);
      if (isMainnet(this.launchNetwork) && diff < 0) {
        throw "Not enough total balance";
      }
    }
  }
  async distribute(token) {
    await this._checkEnoughTokensToDistribute(token);
    for (let name in this.distribution) {
      await _sendTokens(this.getContract(token), name, this.addressOf(name), this.distribution[name]);
    }
  }

  // ownership transfer
  async transferOwnershipToMultisig(name) {
    await _transferOwnership(name, getContract(name), this.multisig_address);
  }
  async transferOwnershipToMultisigMultiple(arrOfNames) {
    for (let name of arrOfNames) {
      await transferOwnershipToMultisig(name);
    }
  }
  async verify() {
    await _verifyAll(this.contracts, this.launchNetwork);
  }
  async mine() {
    advanceTimeAndBlock(20, hre.ethers);
  }

  async postRun() {
    await _postRun(this.contracts, this.launchNetwork);
    let finalBalance = await hre.ethers.provider.getBalance(this.address);
    let finalBlockTime = (await hre.ethers.provider.getBlock()).timestamp;
    let overrides = await this.getOverrides(this.launchNetwork);
    log(
      `Total cost of deploys: ${
        this.initialBalance.sub(finalBalance).toString() / 1e18
      } with gas settings: ${JSON.stringify(printOverrides(overrides))}. Took ${
        finalBlockTime - this.currentBlockTime
      } seconds`,
    );
    await this.verify();
  }

  log(txt) {
    log(txt);
  }

  parseEther(n) {
    return hre.ethers.utils.parseEther(n);
  }

  async waitIfNotLocalHost() {
    if (notLocal(this.launchNetwork)) {
      await wait(5000); // 5 sec wait
    }
  }
}

module.exports = {
  _deployInitializableContract: _deployInitializableContract,
  _deployContract: _deployContract,
  _getAddress: _getAddress,
  _verify: _verify,
  _verifyAll: _verifyAll,
  _postRun: _postRun,
  _getOverrides: _getOverrides,
  log: log,
  isMainnet: isMainnet,
  _transact: _transact,
  _sendTokens: _sendTokens,
  _transferOwnership: _transferOwnership,
  _getContract: _getContract,
  advanceTimeAndBlock: advanceTimeAndBlock,
  DeployHelper: DeployHelper,
};
