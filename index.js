"use strict";

var ATCommander = require('at-commander');
var Promise = require('promise');
var PDU = require('pdu');
var stream = require('stream'),
    http = require('http'),
    mqtt = require('mqtt'),
    url = require('url');

// var Command = ATCommander.Command;

const PROTOCOL_TCP = 0;
const PROTOCOL_UDP = 1;

exports.Protocols = {
    TCP: PROTOCOL_TCP,
    UDP: PROTOCOL_UDP
};

exports.NetworkRegistrationStates = {
    NotRegisteredNotSearching: 0,
    RegisteredHome: 1,
    NotRegisteredButSearching: 2,
    RegistrationDenied: 3,
    Unknown: 4,
    RegisteredRoaming: 5
};

exports.SocketStates = {
    Closed: 0,
    Connected: 1,
    Suspended: 2,
    SuspendedWithPendingData: 3,
    Listening: 4,
    IncomingRequest: 5,
    ResolvingDNS: 6,
    Connecting: 7
};


class TelitModem extends ATCommander.Modem
{
    constructor(options)
    {
        super(options);

        // ip per context
        this._ipByContext = [];

        this._sockets = [];

        this.addNotification('cmsError',/^\+CMS ERROR:(.+)\r\n/, (matches) => {
            console.log("Received error: ", matches);
        });
        this.addNotification('closedSocket', /^NO CARRIER\r\n/, (matches) => {
            // console.log("CHECKING CONS", this.inbuf, this.inbuf.toString() );
            for(var i in this._sockets){
                this._sockets[i]._checkConnection();
            }
        });

        this.startProcessing();

    }

    open(path)
    {
        var promise = super.open(path);

        return new Promise((resolve, reject) => {
            promise.then(()=>{
                // upon open, make sure to disable echo
                this.run("ATE0",/^((ATE0\r\n\r\n)?)OK\r\n/).then(resolve).catch(reject);
            }).catch(reject);
        });
    }

    close(cb)
    {
        // shutdown all sockets
        var l = 0;
        for (var i in this._sockets){
            l++;
            if (l == this._sockets.length){
                this._sockets[i].destroy(() => {
                    super.close(cb);
                });
            } else {
                this._sockets[i].close();
            }

        }

        super.close(cb);
    }

    /**
     * Test function to show how to get simple attributes
     */
    getModel()
    {
        return new Promise((resolve, reject) => {
            this.addCommand("AT+GMM",/^(.+)\r\n\r\nOK\r\n/).then(function(matches){
                resolve(matches[1]);
            }).catch(reject);
        });
    }


    setAPN(APN, pdpType)
    {
        // AT+CGDCONT=[<cid>[,<PDP_type> [,<APN> [,<PDP_addr> [,<d_comp> [,<h_comp> [,<pd1> [,…[,pdN]]]]]]]]]
        var contextId = 1,
            pdpAddr = '""',
            dataCompression = 1,
            headerCompression = 1;

        // type in [IP, IPV6, IPV4V6]
        if (typeof pdpType === 'undefined'){
            pdpType = "IP";
        } else if (["IP","IPV6","IPV4V6"].indexOf(pdpType) != -1){
            // do nothing
        } else {
            throw new Error("Invalid PDP-type given, valid only IP, IPV6, IPV4V6");
        }

        if (typeof APN === 'undefined'){
            throw new Error("APN not given");
        }

        return this.addCommand("AT+CGDCONT=" + contextId + "," + pdpType + "," + APN + "," + pdpAddr + "," + dataCompression + "," + headerCompression);
    }

    getQoS(contextId)
    {
        if (typeof contextId === 'undefined'){
            contextId = 1;
        }
        //AT+CGEQNEG=[<cid> [,<cid>]*]
        return this.addCommand("AT+CGEQNEG=" + contextId);
    }

    getNetworkRegistrationState()
    {
        return new Promise((resolve, reject) => {
            this.addCommand("AT+CREG?", /^\+CREG: (\d+),(\d+)\r\nOK\r\n/).then((matches) => {
                resolve(parseInt(matches[1]), parseInt(matches[2]));
            }).catch(reject);
        });
    }

    subscribeToNetworkRegistrationState(callback)
    {
        this.addNotification("networkRegistrationState", /^\+CREG: (\d+)\r\n/, (buf, matches) => {
            callback(parseInt(matches[1]));
        });
        this.addCommand("AT+CREG=1");
    }

    unsubscribeFromNetworkRegistrationState()
    {
        this.addCommand("AT+CREG=0").then((success) => {
            this.removeNotification("networkRegistrationState");
        });
    }

    enableSMS(receiveCallback)
    {
        // AT+CMGF=<mode> (0: PDU, 1: text)
        this.addCommand("AT+CMGF=0");

        //AT+CNMI=[<mode>[,<mt>[,<bm>[,<ds> [,<bfr>]]]]]
        // flush sms directly to modem
        this.addCommand("AT+CNMI=2,2");

        //+CMT: <alpha>,<length><CR><LF><pdu>
        this.addNotification('receivedSMS', /^\+CMT: "(.*)",(\d+)\r\n(.+)\r\n/, (buf, matches) => {
            // console.log(matches);
            receiveCallback(PDU.parse(matches[3]),matches[1], matches[2]);
        });

        console.log("enableSMS");
    }

    disableSMS()
    {
        this.removeNotification('receivedSMS');
    }


    getServiceCenterAddress()
    {
        return new Promise((resolve, reject) => {
                this.addCommand("AT+CMGF?", /^\+CSCA: (.+),(.+)\r\n/).then((buf, matches) => {
                    resolve(matches[1], matches[2]);
            }).catch(reject);
        });
    }

    setServiceCenterAddress(number, type)
    {
        var str = "AT+CMGF=" + number + (typeof type === 'undefined' ? '' : ',' + type);
        return this.addcommand(str);
    }

    getIP(contextId)
    {
        if (typeof contextId === 'undefined'){
            contextId = 1;
        }
        if (typeof this._ipByContext[contextId] === 'string'){
            return this._ipByContext[contextId];
        }
        return false;
    }

    _setIP(contextId, ip)
    {
        this._ipByContext[contextId] = ip;
    }

    deinitializeNetworking(timeout)
    {
        if (typeof timeout === 'undefined'){
            timeout = 2000;
        }

        // close all sockets
        this.addCommand("AT#SH=1");
        this.addCommand("AT#SH=2");
        this.addCommand("AT#SH=3");
        this.addCommand("AT#SH=4");
        this.addCommand("AT#SH=5");
        this.addCommand("AT#SH=6");

        return new Promise((resolve, reject) => {
            this.disablePDP().then(function(){
                setTimeout(resolve,timeout);
            });
        });
    }

    enablePDP(contextId)
    {
        if (typeof contextId === 'undefined'){
            contextId = 1;
        }

        // if already connected with this context
        if (this.getIP(contextId)){
            return new Promise((resolve, reject) => {
                resolve(this.getIP(contextId));
            });
        }

        return new Promise((resolve, reject) => {
            this.addCommand("AT#SGACT=" + contextId + ",1", /^#SGACT: (.+)\r\n\r\nOK\r\n/, {timeout: 5000}).then((matches) => {
                this._setIP(contextId, matches[1]);
                resolve(matches[1]);
            }).catch(reject);
        });
    }

    disablePDP(contextId)
    {
        if (typeof contextId === 'undefined'){
            contextId = 1;
        }
        return new Promise((resolve, reject) => {
             this.addCommand("AT#SGACT=" + contextId + ",0").then((success) => {
                 this._setIP(contextId, false);
                 resolve(success);
             }).catch(reject);
        });
    }

    /**
     *
     * @param connId            socket connection identifier (1-6)
     * @param contextId         PDP context identifier (default 1, 1-5)
     * @param packetSize        packet size to be used by the TCP/UDP/IP stack for data sending (default 300, 1-1500)
     * @param exchangeTimeout   exchange timeout [sec] (or socket inactivity timeout); if there’s no data exchange within this timeout period the connection is closed.(default 90, 0: no timeout)
     * @param connectTimeout    connection timeout [1/10 sec]; if we can’t establish a connection to the remote within this timeout period, an error is raised. (default 600)
     * @param sendTimeout       data sending timeout; after this period data are sent also if they’re less than max packet size (default 50, 0: no timeout)
     * @returns {*}
     */
    configureSocket(connId, opts)
    {
        opts = Object.assign({
            contextId: 1,
            packetSize: 300,
            exchangeTimeout: 90,
            connectTimeout: 600,
            sendTimeout: 50
        }, opts);

        // AT#SCFG=<connId>,<cid>,<pktSz>,<maxTo>,<connTo>,<txTo>
        return this.addCommand("AT#SCFG=" + connId + "," + opts.contextId + "," + opts.packetSize + "," + opts.exchangeTimeout + "," + opts.connectTimeout + "," + opts.sendTimeout);
    }

    getSocket(options)
    {
        options = Object.assign({
            contextId: 1
        }, options);

        if (typeof options.connId === 'undefined' || typeof this._sockets[options.connId] === 'undefined') {
            // get first unused socket
            if (typeof options.connId === 'undefined') {
                for (var i = 1; i <= 6; i++) {
                    if (typeof this._sockets[i] === 'undefined') {
                        options.connId = i;
                        break;
                    }
                }
            }
            if (typeof contextId === 'undefined'){
                options.contextId = 1;
            }
            this._sockets[options.connId] = new Socket(this, options.connId, options.contextId, options);
        }
        return this._sockets[options.connId];
    }


    http()
    {
        return new ModemHttp(this);
    }

    mqtt(config)
    {
        return new mqtt.Client(() => {
            return this.getSocket({
                exchangeTimeout: 0 // disable generic socket timeout (close on no exchange)
            }).connect(config);
        }, config);
    }

    _freeSocket(socket)
    {
        delete this._sockets[socket._connId];
    }

}

// class ExtCommand extends ATCommander.Command
// {
//     constructor(cmd, expected, resultHandler, processor)
//     {
//
//     }
// }

class Socket extends stream.Duplex
{
    constructor(modem, connId, contextId, options)
    {
        super(options);

        this._modem = modem;
        this._connId = connId;
        this._contextId = contextId;

        // this.writable = false;
        this._connected = false;
        this._closing = false;

        this._pushPossible = false;
        this._recvBuf = new Buffer(0);

        // (re)set  socket options on creation (as we don't know what has happened so far)
        options = options || {};
        options.contextId = this._contextId;
        this.configure(options);

        // this._modem.addCommand("AT#SCFG="+this._connId+"")

        // AT#SCFGEXT=<connId>,<ringMode>,<recvDataMode>,<keepalive>,[,<ListenAutoRsp>[,<sendDataMode>]]
        // set socket sring format to SRING: <connId>,<datalen>,<data>
        // receive in hex mode
        // keepalive deactivated
        this._modem.addCommand("AT#SCFGEXT="+this._connId+",2,1,0");

        // AT#SCFGEXT2=<connId>,<bufferStart>,[,<abortConnAttempt>[,<unused_B >[,<unused_C >[,<noCarrierMode>]]]]
        // buffer timeout reset on new data received
        // enable connection abortion during Socket creation.
        // ARG, this is not supported in the current firmware version...
        // [[enable verbose socket close messages NO CARRIER: <connId>,<cause>]]
        this._modem.addCommand("AT#SCFGEXT2="+this._connId+",1,1");//,0,0,2");

        // AT#SCFGEXT2=<connId>,<immRsp>[....]
        // make AT#SD (open socket) command blocking
        // ARG! this command isn't even supported for the moment being
        // this._modem.addCommand("AT#SCFGEXT3="+this._connId+",0");

    }

    configure(opts)
    {
        this._modem.configureSocket(this._connId, opts);
    }

    isConnected()
    {
        return this._connected;
    }

    connect(options, connectListener)
    {
        if (this._connected){
            throw new Error("Already connected");
        }

        this._registerListeners();

        // required
        this.port = options.port;
        this.host = options.host;

        this.protocol = options.transportProtocol || PROTOCOL_TCP;

        this.localPort = options.localPort || Math.ceil(65535 * Math.random());

        var closureMode = 0; // let server close connection
        var conMode = 1;     // command mode connection

        var cmd = "AT#SD=" + this._connId + "," + this.protocol + "," + this.port + ",\"" + this.host + "\"," + closureMode + "," + this.port + "," + conMode;
        var command = new ATCommander.Command(cmd, "OK", {timeout: 5000});

        if (typeof connectListener !== 'function'){
            connectListener = function(){};
        }


        this._modem.addCommand(command).then((result) => {
            if (result){
                // this.writable = true;
                this._connected = true;
                connectListener();
            } else {
                connectListener(command);
            }
        }).catch(connectListener);

        return this;
    }

    _registerListeners()
    {

        // // register receive handler
        // this._modem.addNotification('socketRing-'+this._connId, new RegExp("^\r\nSRING: "+this._connId+",(.+)\r\n"), (buf,matches) => {
        //
        //     // console.log("SRING => got " + matches[1] + " bytes");
        //     //#SRECV: <sourceIP>,<sourcePort><connId>,<recData>,<dataLeft>
        //     this._modem.addCommand("AT#SRECV="+this._connId+","+matches[1], new RegExp("^\r\n#SRECV: "+this._connId+",(\\d+)\r\n(.+)\r\n\r\nOK\r\n")).then((result) => {
        //     // console.log("srecv");
        //         this._push(new Buffer(result[2],"hex"));
        //     }).catch((err) => console.log("error",err));
        // });
         // register receive handler
        this._modem.addNotification('socketRing-'+this._connId, new RegExp("^SRING: "+this._connId+",(.+),(.+)\r\n"), (buf,matches) => {
            this._push(new Buffer(matches[2],"hex"));
        });

        // add socket closed notification  NO CARRIER: <connId>,<cause>
        this._modem.addNotification('socketClose-'+this._connId, new RegExp("^NO CARRIER: "+this._connId+",(.+)\r\n"), (result) => {
            this._disconnect();
        });
    }

    _unregisterListeners()
    {
        this._modem.removeNotification('socketRing-'+this._connId);
        this._modem.removeNotification('socketClose-'+this._connId);

    }

    close(disconnectListener)
    {

        if (typeof disconnectListener !== 'function'){
            disconnectListener = function(){};
        }

        // this.closing = true

        // console.log("close()", this._connected);
        if (this._connected){
            this._disconnected();

            this._modem.addCommand("AT#SH=" + this._connId, "OK").then((result) => {
                disconnectListener();
            }).catch(disconnectListener);
            //throw new Error("Already disconnected");
        } else {
            disconnectListener();
        }
    }

    _checkConnection()
    {
        if (!this._connected){
            //
            return;
        }

        // console.log("Checking for socket state");
        this._modem.addCommand("AT#SS=" + this._connId, /^#SS: (\d+),(\d+)\r\n\r\nOK\r\n/).then((matches) => {
            // console.log("state",matches);
            switch(parseInt(matches[2])){
                case exports.SocketStates.Closed:
                    // console.log("Detected socket close");
                    this._disconnected();
                    // this.destroy();
                    break;
            }
        });
    }

    _disconnected(callback)
    {
        this._connected = false;
        this._unregisterListeners();

        if (typeof cb === 'function'){
            callback();
        }
    }

    destroySoon()
    {
        this.writable = false;
        // console.log()
        // this.endWritable(this,)
        // this.close();
        // return true;
    }
    destroy()
    {
        this.close();
    }

    free(){
        this.close(() => {
            this._modem._freeSocket(this);
        });
    }


    _push(recvBuf)
    {
        if (this._pushPossible) {
            this._pushPossible = this.push(recvBuf);
        } else {
            this._recvBuf = Buffer.concat([this._recvBuf]);
        }
    }

    _read(size)
    {
        this._pushPossible = true;

        if (this._recvBuf.length) {
            var buf = this._readBuf;
            this._recvBuf = new Buffer(0);

            // console.log("pushing data", buf);

            this._pushPossible = this.push(buf);
        }
    }

    _write(chunk, encoding, callback)
    {
        // console.log("_write",chunk.toString());
        this._modem.addCommand("AT#SSENDEXT=" + this._connId + "," + chunk.length, /^> /).then(() => {
            this._modem.addCommand(chunk).then(function(){
                callback(null);
            }).catch(callback);
        });
    }

    _writev(chunks, callback)
    {
        for(var i in chunks){
            this._write(chunks[i], callback);
        }
    }

}

class ModemHttp
{

    constructor(modem)
    {
        // console.log("constructed ModemHttp");
        this._modem = modem;
    }

    request(options, callback, end)
    {
        options.createConnection = (config, cb) => {
        // console.log("config", config);
            this.socket = this._modem.getSocket();
            this.socket.on('end',() => {
                 this.close();
            });
            return this.socket.connect(config,() => {
                if (end){
                    this.request.end();
                }
            });
        };

        this.request = http.request(options,callback);

        return this.request;
    }

    get(options, callback)
    {
        if (typeof options === 'string'){
            options = url.parse(options);
        }

        return this.request(options, callback, true);
    }
}

exports.TelitModem = TelitModem;
exports.Socket = Socket;

