
var WebDFU = require("webdfu");
var DFU = WebDFU.DFU;
var DFUse = WebDFU.DFUse;

var Storage = require("./Storage");
var Recovery = require("./Recovery");

const AUTOCONNECT_DELAY = 1000;
const SLOT_START = {
    A: 0x90000000,
    B: 0x90400000,
};
const HEADER_OFFSET = 0x8;
const USERLAND_OFFSETS = [0x10000, 0x20000];

/**
 * Class handling communication with a Numworks
 * calculator using WebUSB and the WebDFU lib.
 *
 * @author Maxime "M4x1m3" FRIESS
 * @license MIT
 */
class Numworks {
    constructor() {
        this.device = null;
        this.transferSize = 2048;
        this.manifestationTolerant = false;
        this.autoconnectId = null;
    }

    /**
     * Get the model of the calculator.
     *
     * @param   exclude_modded  Only include calculator which can be officially purchased from Numworks.
     *                          This includes "0100" and "0110". If a modded Numworks is found, it'll show
     *                          the unmoded version (eg. "0100-8M" becomes "0100").
     *
     * @return  "0110" for an unmodified n0110 (64K internal 8M external).                      "0110" is returned with {exclude_modded}.
     *          "0110-0M" for a modified n0110 (64K internal, no external).                     "????" is returned with {exclude_modded}.
     *          "0110-16M" for a modified n0110 (64K internal, 16M external).                   "0110" is returned with {exclude_modded}.
     *          "0100" for unmodified n0100 (1M internal, no external).                         "0100" is returned with {exclude_modded}.
     *          "0100-8M"  for a "Numworks++" with 8M external (1M internal, 8M external).      "0100" is returned with {exclude_modded}.
     *          "0100-16M" for a "Numworks++" with 16M external (1M internal, 16M external).    "0100" is returned with {exclude_modded}.
     *
     *          Other flash sizes don't exist for the packaging the Numworks (SOIC-8) uses, so it's safe to assume
     *          we'll only encounter 0M, 8M and 16M versions.
     *
     *          "????" if can't be determined (maybe the user plugged a DFU capable device which isn't a Numworks).
     */
    getModel(exclude_modded = true) {
        var internal_size = 0;
        var external_size = 0;

        for (let i = 0; i < this.device.memoryInfo.segments.length; i++) {

            if (this.device.memoryInfo.segments[i].start >= 0x08000000 && this.device.memoryInfo.segments[i].start <= 0x080FFFFF) {
                internal_size += this.device.memoryInfo.segments[i].end - this.device.memoryInfo.segments[i].start;
            }

            if (this.device.memoryInfo.segments[i].start >= 0x90000000 && this.device.memoryInfo.segments[i].start <= 0x9FFFFFFF) {
                external_size += this.device.memoryInfo.segments[i].end - this.device.memoryInfo.segments[i].start;
            }
        }

        // If it's an Upsilon calculator, some sectors can be hidden
        if (this.device.device_.productName == "Upsilon Bootloader") {
            return "0110";
        }

        if (this.device.device_.productName == "Upsilon Calculator") {
            return external_size ? "0110" : "0100";
        }

        let usbDeviceVersion = "" + this.device.device_.deviceVersionMajor + this.device.device_.deviceVersionMinor + this.device.device_.deviceVersionSubminor
        switch (usbDeviceVersion) {
            case "120":
                return "0120";
            case "115":
                return "0115";
            case "110":
                return "0110"
            // We can't match on N0100 as some N0110 firmware are returning 100
        }

        if (internal_size === 0x10000 || internal_size === 0x0) {
            if (external_size === 0) {
                return (exclude_modded ? "????" : "0110-0M");
            } else if (external_size === 0x800000) {
                return "0110";
            } else if (external_size === (0x800000 - 0x30000)) {
                // Epsilon 22 hide a part of the flash beginning, IDK why
                return "0110"
            } else if (external_size === 0x1000000) {
                return (exclude_modded ? "0110" : "0110-16M");
            } else {
                return "????";
            }
        } else if (internal_size === 0x100000) {
            if (external_size === 0) {
                return "0100";
            } else if (external_size === 0x800000) {
                return (exclude_modded ? "0100" : "0100-8M");
            } else if (external_size === 0x1000000) {
                return (exclude_modded ? "0100" : "0100-16M");
            } else {
                return "????";
            }
        } else {
            return "????";
        }
    }

    /**
     * Flash buffer to internal flash.
     *
     * @param   buffer      ArrayBuffer to flash.
     */
    async flashInternal(buffer) {
        this.device.startAddress = 0x08000000;
        await this.device.do_download(this.transferSize, buffer, true);
    }

    /**
     * Flash buffer to external flash.
     *
     * @param   buffer      ArrayBuffer to flash.
     */
    async flashExternal(buffer) {
        this.device.startAddress = 0x90000000;
        await this.device.do_download(this.transferSize, buffer, false);
    }

    async __getDFUDescriptorProperties(device) {
        // Attempt to read the DFU functional descriptor
        // TODO: read the selected configuration's descriptor
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = DFU.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue === configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType === 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) !== 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) !== 0),
                        CanUpload:             ((funcDesc.bmAttributes & 0x02) !== 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) !== 0),
                        TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    /**
     * Detect a numworks calculator.
     *
     * @param   successCallback     Callback in case of success.
     * @param   errorCallback       Callback in case of error.
     */
    async detect(successCallback, errorCallback) {
        var _this = this;
        await navigator.usb.requestDevice({ "filters": [{"vendorId": 0x0483, "productId": 0xa291}]}).then(
            async selectedDevice => {
                let interfaces = DFU.findDeviceDfuInterfaces(selectedDevice);
                _this.dfuInterfaceCount = interfaces.length;
                await _this.__fixInterfaceNames(selectedDevice, interfaces);
                _this.device = await _this.__connect(new DFU.Device(selectedDevice, interfaces[0]));
                successCallback();
            }
        ).catch(error => {
            errorCallback(error);
        });
    }

    /**
     * Connect to a WebDFU device.
     *
     * @param   device      The WebUSB device to connect to.
     */
    async __connect(device) {
        try {
            await device.open();
        } catch (error) {
            // this.installInstance.calculatorError(true, error);
            throw error;
        }

        // Attempt to parse the DFU functional descriptor
        let desc = {};
        try {
            desc = await this.__getDFUDescriptorProperties(device);
        } catch (error) {
            // this.installInstance.calculatorError(true, error);
            throw error;
        }

        if (desc && Object.keys(desc).length > 0) {
            device.properties = desc;
            this.transferSize = desc.TransferSize;
            if (desc.CanDnload) {
                this.manifestationTolerant = desc.ManifestationTolerant;
            }

            if ((desc.DFUVersion === 0x100 || desc.DFUVersion === 0x011a) && device.settings.alternate.interfaceProtocol === 0x02) {
                device = new DFUse.Device(device.device_, device.settings);
                if (device.memoryInfo) {
                    // We have to add RAM manually, because the device doesn't expose that normally
                    // TODO: Recent Epsilon versions expose the RAM on a
                    // different alt interface.
                    // We should extract the memoryInfo from both interfaces
                    // instead of hardcoding, and automatically switch to the
                    // right one
                    device.memoryInfo.segments.unshift({
                        start: 0x20000000,
                        sectorSize: 1024,
                        end: 0x20040000,
                        readable: true,
                        erasable: false,
                        writable: true
                    });

                    device.memoryInfo.segments.unshift({
                        start: 0x24000000,
                        sectorSize: 1024,
                        end: 0x24040000,
                        readable: true,
                        erasable: false,
                        writable: true
                    });
                }

                // Newer Epsilon versions expose 2 USB alt interface for DFU,
                // and we need to know if we can/need to switch interfaces
                // before reading the version (getPlatformInfo).
                // WebDFU doesn't support automatic interface switching, so we
                // need our own wrapper around its methods
                // Some Upsilon.js users (e.g. Upsilon Website) directly use
                // do_upload, so automatic switching is required for backward
                // compatibility
                const originalUpload = device.do_upload.bind(device);
                const originalDownload = device.do_download.bind(device);

                device.do_upload = async (...args) => {
                    await this.__switchAltInterfaces();
                    return originalUpload(...args);
                };

                device.do_download = async (...args) => {
                    await this.__switchAltInterfaces();
                    return originalDownload(...args);
                };
            }
        }

        // Bind logging methods
        device.logDebug = console.log;
        device.logInfo = console.info;
        device.logWarning = console.warn;
        device.logError = console.error;
        device.logProgress = console.log;

        return device;
    }

    async __switchAltInterfaces() {
        if (this.device.device_.configurations[0].interfaces[0].alternates.length > 1) {
            if (0x20000000 <= this.device.startAddress && this.device.startAddress <= 0x2404FFFF) {
                await this.device.device_.selectAlternateInterface(this.device.intfNumber, 1);
            } else {
                await this.device.device_.selectAlternateInterface(this.device.intfNumber, 0);
            }
        }
    }

    __readFString(dv, index, len) {
        var out = "";
        for(var i = 0; i < len; i++) {
            var chr = dv.getUint8(index + i);

            if (chr === 0 || chr === 0xFF) {
                break;
            }

            out += String.fromCharCode(chr);
        }

        return out;
    }

    __parseKernelHeader(array) {
        var dv = new DataView(array);
        var data = {};

        const magiks = [0xF00DC0DE, 0xFEEDC0DE];

        // Used as pointer when reading
        let currentAddress = 0x0;

        data["magik"] = dv.getUint32(currentAddress, false);
        currentAddress += 0x4

        // Iterate over the magiks to find the correct one
        let magikFound = false;
        for(var i = 0; i < magiks.length; i++) {
            if (data["magik"] === magiks[i]) {
                magikFound = true;
                break;
            }
        }
        if (!magikFound) {
            data["magik"] = false;
            console.warn("No kernel magic")
            return data
        }

        data["version"] = this.__readFString(dv, currentAddress, 8);
        currentAddress += 0x8

        data["commit"] = this.__readFString(dv, currentAddress, 8);
        currentAddress += 0x8

        // End of the kernel header, next is the magic
        if (dv.getUint32(currentAddress, false) !== data["magik"]) {
            console.warn("PlatformInfo is not valid, end magic is not present at the end of the Kernel header");
        }

        return data
    }


    __parseCustomInfos(dv, startAddress) {
        let data = {};

        let currentAddress = startAddress

        // Omega infos
        data["omega"] = {};

        data["omega"]["installed"] = dv.getUint32(currentAddress, false) === 0xDEADBEEF
        currentAddress += 4

        if (data["omega"]["installed"]) {
            data["omega"]["version"] = this.__readFString(dv, currentAddress, 16);
            currentAddress += 16;

            data["omega"]["user"] = this.__readFString(dv, currentAddress, 16);
            currentAddress += 16;

            if(dv.getUint32(currentAddress, false) !== 0xDEADBEEF) {
                console.warn("Omega Magic not present at end")
            }
            currentAddress += 4
        }

        // Upsilon infos
        data["upsilon"] = {};
        data["upsilon"]["installed"] = dv.getUint32(currentAddress, false) === 0x69737055

        currentAddress += 4

        if (data["upsilon"]["installed"]) {
            data["upsilon"]["version"] = this.__readFString(dv, currentAddress, 16);
            currentAddress += 16;

            data["upsilon"]["osType"] = dv.getUint32(currentAddress, false);
            currentAddress += 4

            if (data["upsilon"]["osType"] == 0x78718279) {
                data["upsilon"]["official"] = true;
            } else {
                data["upsilon"]["official"] = false;
            }

            if (dv.getUint32(currentAddress, false) !== 0x69737055) {
                console.warn("Upsilon Magic not present at end")
            }
            currentAddress += 4
        }

        // SaltyOS infos
        currentAddress = startAddress + 0x0C
        data["saltyOS"] = {};
        data["saltyOS"]["installed"] = dv.getUint32(currentAddress, false) === 0x536C7479

        currentAddress += 4

        if (data["saltyOS"]["installed"]) {
            data["saltyOS"]["version"] = this.__readFString(dv, currentAddress, 8);
            currentAddress += 8;

            data["saltyOS"]["commit"] = this.__readFString(dv, currentAddress, 8);
            currentAddress += 8

            data["saltyOS"]["themesArea"] = { A: {}, B: {} };
            data["saltyOS"]["themesArea"]["A"]["start"] = dv.getUint32(currentAddress, true);
            currentAddress += 4
            data["saltyOS"]["themesArea"]["A"]["end"] = dv.getUint32(currentAddress, true);
            currentAddress += 4
            data["saltyOS"]["themesArea"]["B"]["start"] = dv.getUint32(currentAddress, true);
            currentAddress += 4
            data["saltyOS"]["themesArea"]["B"]["end"] = dv.getUint32(currentAddress, true);
            currentAddress += 4

            if (dv.getUint32(currentAddress, false) !== 0x536C7479) {
                console.warn("SaltyOS Magic not present at end")
            }
            currentAddress += 4
        }

        return data
    }

    __parseUserlandHeader(array) {
        var dv = new DataView(array);
        var data = {};

        const magiks = [0xF00DC0DE, 0xFEEDC0DE];

        // Used as pointer when reading
        let currentAddress = 0;

        data["magik"] = dv.getUint32(currentAddress, false);
        currentAddress += 4

        // Iterate over the magiks to find the correct one
        let magikFound = false;
        for(var i = 0; i < magiks.length; i++) {
            if (data["magik"] === magiks[i]) {
                magikFound = true;
                break;
            }
        }
        if (!magikFound) {
            data["magik"] = false;
            console.warn("No userland magic")
            return data
        }

        data["version"] = this.__readFString(dv, currentAddress, 8);
        currentAddress += 8

        // Storage
        data["storage"] = {};
        data["storage"]["address"] = dv.getUint32(currentAddress, true);
        currentAddress += 4
        data["storage"]["size"] = dv.getUint32(currentAddress, true);
        currentAddress += 4

        // External
        data["external"] = {};
        data["external"]["flashStart"] = dv.getUint32(currentAddress, true);
        currentAddress += 4
        data["external"]["flashEnd"] = dv.getUint32(currentAddress, true);
        currentAddress += 4
        data["external"]["flashSize"] = data["external"]["flashEnd"] - data["external"]["flashStart"];

        data["external"]["ramStart"] = dv.getUint32(currentAddress, true);
        currentAddress += 4
        data["external"]["ramEnd"] = dv.getUint32(currentAddress, true);
        currentAddress += 4
        data["external"]["ramSize"] = data["external"]["ramEnd"] - data["external"]["ramStart"];

        if (dv.getUint32(currentAddress, false) !== data["magik"]) {
            if (data["version"] < "22.0.0") {
                console.warn("PlatformInfo is not valid, end magic is not present at the end of the Userland info for Epsilon 21, using Epsilon 22 struct");
            }

            // Epsilon 22 (username)
            data["epsilon"] = {}
            data["epsilon"]["usernameStart"] = dv.getUint32(currentAddress, true);
            currentAddress += 4
            data["epsilon"]["usernameEnd"] = dv.getUint32(currentAddress, true);
            currentAddress += 4
            data["epsilon"]["usernameSize"] = data["epsilon"]["usernameEnd"] - data["epsilon"]["usernameStart"]
        }

        if (dv.getUint32(currentAddress, false) !== data["magik"]) {
            console.warn("PlatformInfo is not valid, end magic is not present at the end of the Kernel header");
        }
        currentAddress += 4

        data = { ...data, ...this.__parseCustomInfos(dv, currentAddress)}

        return data
    }

    async __parsePlatformInfo(array) {
        // Parse legacy platform infos
        var dv = new DataView(array);
        var data = {};

        const magiks = [0xF00DC0DE, 0xFEEDC0DE];

        data["magik"] = dv.getUint32(0x00, false);

        // Iterate over the magiks to find the correct one
        let magikFound = false;
        for(var i = 0; i < magiks.length; i++) {
            if (data["magik"] === magiks[i]) {
                magikFound = true;
                break;
            }
        }
        if (!magikFound) {
            data["magik"] = false;
        }


        if (data["magik"]) {
            data["oldplatform"] = !(dv.getUint32(0x1C, false) === data["magik"]);

            data["username"] = ""

            data["omega"] = {};

            if (data["oldplatform"]) {
                data["omega"]["installed"] = dv.getUint32(0x1C + 8, false) === data["magik"] || dv.getUint32(0x1C + 16, false) === 0xDEADBEEF || dv.getUint32(0x1C + 32, false) === 0xDEADBEEF;
                if (data["omega"]["installed"]) {
                    data["omega"]["version"] = this.__readFString(dv, 0x0C, 16);

                    data["omega"]["user"] = "";

                }

                data["version"] = this.__readFString(dv, 0x04, 8);
                var offset = 0;
                if (dv.getUint32(0x1C + 8, false) === data["magik"]) {
                    offset = 8;
                } else if (dv.getUint32(0x1C + 16, false) === data["magik"]) {
                    offset = 16;
                } else if (dv.getUint32(0x1C + 32, false) === data["magik"]) {
                    offset = 32;
                }

                data["commit"] = this.__readFString(dv, 0x0C + offset, 8);
                data["storage"] = {};
                data["storage"]["address"] = dv.getUint32(0x14 + offset, true);
                data["storage"]["size"] = dv.getUint32(0x18 + offset, true);
            } else {
                data["version"] = this.__readFString(dv, 0x04, 8);
                data["storage"] = {};
                data["commit"] = this.__readFString(dv, 0x0C, 8);
                data["storage"]["address"] = dv.getUint32(0x14, true);
                data["storage"]["size"] = dv.getUint32(0x18, true);

                data = {...data, ...this.__parseCustomInfos(dv, 0x20)}
            }
        } else {
            data["omega"] = false;
        }


        return data;
    }

    __parseSlotInfo(array) {
        var dv = new DataView(array);
        let data = {};
        data["slot"] = {};

        const magik = 0xBADBEEEF;
        // Hack to handle corrupted slotInfo magik on old Upsilon Bootloader versions (pre 1.0.13)
        data["slot"]["magik"] = (dv.getUint32(0x00, false) == magik) || ((dv.getUint32(0x00, false) & 0x00FFFFFF) == (magik & 0x00FFFFFF));
        // Check if the data is valid
        if (data["slot"]["magik"]) {
            // Check if the end magic is present
            if (dv.getUint32(0x0C, false) !== magik) {
                console.warn("SlotInfo is not valid, end magic is not present at the end of the slot info");
            }
            data["slot"]["kernelHeader"] = dv.getUint32(0x04, true);
            data["slot"]["userlandHeader"] = dv.getUint32(0x08, true);
            // Guess the active slot based on the kernel header
            const slotList = {
                0x90000000: "A",
                0x90400000: "B",
                0x90180000: "Khi",
            };
            let slotStart = data["slot"]["kernelHeader"] - 0x8;
            // Get the slot name from the list
            data["slot"]["kernelName"] = slotList[slotStart];
            // Check if the slot is valid
            if (data["slot"]["kernelName"] == undefined) {
                console.warn("Slot name is not valid, the kernel header is not in the list");
            }

            // Slot of the running userland
            // It differs from the kernel one when a launcher jumps to the userland of the other slot.
            let userlandName;
            if (data["slot"]["userlandHeader"] === SLOT_START.A + 0x20000) {
                userlandName = "A";
            } else if (data["slot"]["userlandHeader"] === SLOT_START.B + 0x20000) {
                userlandName = "B";
            }
            data["slot"]["name"] = userlandName ?? data["slot"]["kernelName"];
            if(this.dfuInterfaceCount < 2) data["slot"]["name"] = "Bootloader";
        }
        return data;
    }

    async __readSlot(kernelHeaderAddress, userlandCandidates) {
        try {
            // Kernel header
            this.device.startAddress = kernelHeaderAddress;
            let blob = await this.device.do_upload(this.transferSize, 0x64);
            const kernel = this.__parseKernelHeader(await blob.arrayBuffer());

            // Userland header: look for the first candidate address with a valid magik
            let userland = null;
            let userlandHeaderAddress = null;
            for (const address of userlandCandidates) {
                this.device.startAddress = address;
                blob = await this.device.do_upload(this.transferSize, 0x128);
                const buffer = await blob.arrayBuffer();

                if (this.__hasMagik(buffer)) {
                    userland = this.__parseUserlandHeader(buffer);
                    userlandHeaderAddress = address;
                    break;
                }
            }

            // read Epsilon 22+ username
            if (userland && userland["epsilon"]) {
                this.device.startAddress = userland["epsilon"]["usernameStart"];
                const usernameBlob = await this.device.do_upload(this.transferSize, userland["epsilon"]["usernameSize"]);
                const usernameDv = new DataView(await usernameBlob.arrayBuffer());

                userland["epsilon"]["username"] = this.__readFString(usernameDv, 0, userland["epsilon"]["usernameSize"]);
            }

            return {
                ...kernel,
                ...userland,
                valid: Boolean(kernel.magik && userland),
                kernelHeaderAddress,
                userlandHeaderAddress,
            };
        } catch (error) {
            console.warn("Unable to read slot headers", error);
            return { valid: false, magik: false, kernelHeaderAddress };
        }
    }

    __getActiveSlotData(pinfo) {
        if (pinfo["mode"] !== "bootloader") {
            // Legacy firmware: the infos are at the root
            return pinfo;
        }

        const slot = pinfo["slot" + pinfo["slot"]["name"]];
        if (!slot || !slot.valid) {
            throw new Error("Active slot is not readable");
        }

        return slot;
    }

    __hasMagik(array) {
        const magiks = [0xF00DC0DE, 0xFEEDC0DE];
        return magiks.includes(new DataView(array).getUint32(0, false));
    }


    /**
     * Get the platforminfo section of the calculator.
     *
     * @return  an object representing the platforminfo.
     */
    async getPlatformInfo() {
        // Get the Model. On N0120; address is different
        let model = this.getModel();

        // Get the slot infos to know the configuration
        this.device.startAddress = model == "0120" ? 0x24000000 : 0x20000000;
        let blob = await this.device.do_upload(this.transferSize, 0x64);
        let slotInfo = this.__parseSlotInfo(await blob.arrayBuffer())["slot"];

        if (!slotInfo["magik"]) {
            // If no magik is present, it means that there is no slot info, so it's a legacy firmware
            this.device.startAddress = 0x080001c4;
            blob = await this.device.do_upload(this.transferSize, 0x128);
            const data = await this.__parsePlatformInfo(await blob.arrayBuffer());
            data["mode"] = "legacy";
            return data;
        }

        const activeName = slotInfo["name"];

        const data = {
            mode: "bootloader",
            oldplatform: false,
            model: model,
            slot: slotInfo,
        };

        for (const [name, start] of Object.entries(SLOT_START)) {
            if (name === activeName) {
                // Active slot: use the real addresses given by the bootloader
                data["slot" + name] = await this.__readSlot(slotInfo["kernelHeader"], [slotInfo["userlandHeader"]]);
            } else {
                // Inactive slot: the userland offset depends on the firmware, so try the known ones
                data["slot" + name] = await this.__readSlot(
                    start + HEADER_OFFSET,
                    USERLAND_OFFSETS.map(offset => start + offset)
                );
            }
        }

        // Active slot which is neither A nor B (eg. "Khi")
        if (activeName !== undefined && SLOT_START[activeName] === undefined) {
            data["slot" + activeName] = await this.__readSlot(slotInfo["kernelHeader"], [slotInfo["userlandHeader"]]);
        }

        return data;
    }

    async __autoConnectDevice(device) {
        let interfaces = DFU.findDeviceDfuInterfaces(device.device_);
        this.dfuInterfaceCount = interfaces.length;
        await this.__fixInterfaceNames(device.device_, interfaces);
        device = await this.__connect(new DFU.Device(device.device_, interfaces[0]));
        return device;
    }

    /**
     * Autoconnect a numworks calculator
     *
     * @param   serial      Serial number. If ommited, any will work.
     */
    autoConnect(callback, serial) {
        var _this = this;
        var vid = 0x0483, pid = 0xa291;

        DFU.findAllDfuInterfaces().then(async dfu_devices => {
            let matching_devices = _this.__findMatchingDevices(vid, pid, serial, dfu_devices);

            if (matching_devices.length !== 0) {
                this.stopAutoConnect();

                this.device = await this.__autoConnectDevice(matching_devices[0]);

                await callback();
            }
        });

        this.autoconnectId = setTimeout(this.autoConnect.bind(this, callback, serial), AUTOCONNECT_DELAY);
    }

    /**
     * Stop autoconnection.
     */
    stopAutoConnect() {
        if (this.autoconnectId === null) return;

        clearTimeout(this.autoconnectId);

        this.autoconnectId = null;
    }

    async __fixInterfaceNames(device_, interfaces) {
        // Check if any interface names were not read correctly
        if (interfaces.some(intf => (intf.name === null))) {
            // Manually retrieve the interface name string descriptors
            let tempDevice = new DFU.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (intf.name === null) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    __findMatchingDevices(vid, pid, serial, dfu_devices) {
        let matching_devices = [];
        for (let dfu_device of dfu_devices) {
            if (serial) {
                if (dfu_device.device_.serialNumber === serial) {
                    matching_devices.push(dfu_device);
                }
            } else {
                if (
                    (!pid && vid > 0 && dfu_device.device_.vendorId  === vid) ||
                    (!vid && pid > 0 && dfu_device.device_.productId === pid) ||
                    (vid > 0 && pid > 0 && dfu_device.device_.vendorId  === vid && dfu_device.device_.productId === pid)
                )
                {
                    matching_devices.push(dfu_device);
                }
            }
        }

        return matching_devices;
    }

    /**
     * Get storage from the calculator.
     *
     * @param   address     Storage address
     * @param   size        Storage size.
     * @param   version     Calculator version
     *
     * @return  The storage, as a Blob.
     */
    async __retrieveStorage(address, size, version) {
        this.device.startAddress = address;
        let data = await this.device.do_upload(this.transferSize, size + 8);

        return data
    }

    /**
     * Flash storage to the calculator.
     *
     * @param   address     Storage address
     * @param   data        Storage data.
     * @param   version     Calculator version
     */
    async __flashStorage(address, data, version) {
        this.device.startAddress = address;
        await this.device.do_download(this.transferSize, data, false);
    }

    /**
     * Install new storage in calculator
     *
     * @param   storage     Storage class, representing the storage.
     * @param   callback    Callback to be called when done.
     *
     * @throw   Error       If storage is too big.
     */
    async installStorage(storage, callback) {
        // The storage location depends on the active slot
        const active = this.__getActiveSlotData(await this.getPlatformInfo());

        let storage_blob = await storage.encodeStorage(active["storage"]["size"]);
        await this.__flashStorage(active["storage"]["address"], await storage_blob.arrayBuffer(), active["version"]);

        callback();
    }

    /**
     * Get and parse storage on the calculator.
     *
     * @return  Storage class describing the storage of the calculator.
     */
    async backupStorage() {
        // The storage location depends on the active slot
        const active = this.__getActiveSlotData(await this.getPlatformInfo());

        let storage_blob = await this.__retrieveStorage(active["storage"]["address"], active["storage"]["size"], active["version"]);

        let storage = new Numworks.Storage();

        await storage.parseStorage(storage_blob);

        return storage;
    }

    /**
     * Crash the calculator by reading at a forbidden address
     *
     * @returns Boolean, True if the calculator crashed successfully
     */
    async crash() {
        this.device.startAddress = 0xDEADBEEF;
        try {
            const blob = await this.device.do_upload(this.transferSize, 0x128);
            return false;
        } catch {
            return true;
        }
    }

    /**
     * Write the username of a slot in the flash.
     * Only works with slots having a username page (Epsilon 22+).
     *
     * @param   slot        Slot to write to ("A" or "B").
     * @param   username    New username.
     *
     * @throw   Error       If the slot has no username page or if the username is too long.
     */
    async writeUsername(slot, username) {
        const pinfo = await this.getPlatformInfo();
        const epsilon = pinfo["slot" + slot]?.["epsilon"];

        if (!epsilon) {
            throw new Error("Slot " + slot + " has no username page");
        }
        if (username.length + 1 > epsilon["usernameSize"]) {
            throw new Error("Username is too long (max " + (epsilon["usernameSize"] - 1) + " characters)");
        }

        const buffer = new Uint8Array(username.length + 1);
        for (let i = 0; i < username.length; i++) {
            buffer[i] = username.charCodeAt(i);
        }

        await this.__flashStorage(epsilon["usernameStart"], buffer.buffer);
    }

    onUnexpectedDisconnect(event, callback) {
        if (this.device !== null && this.device.device_ !== null) {
            if (this.device.device_ === event.device) {
                this.device.disconnected = true;
                callback(event);
                this.device = null;
            }
        }
    }
}

Numworks.Recovery = Recovery;
Numworks.Storage = Storage;

module.exports = Numworks;

