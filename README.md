# Telit-Modem

Telit Modem interface for serial ports (with focus on HE910-D and similiar series) NodeJS

__Please note that this is still a beta version__

This module is also a showcase for how you can customize the generic [ATCommander.Modem](https://www.npmjs.com/package/at-commander) for your specific devices.


## Examples

### SMS

    var TelitModem = require('telit-modem');

    var CREG = TelitModem.NetworkRegistrationStates;

    var modem = new TelitModem.TelitModem();

    modem.open('COM4').catch((err) => {
        console.error("Failed to open serial port", err);
    }).then(() => {
        console.log("Opened serial port");

        process.on('SIGINT', function () {
            modem.unsubscribeFromNetworkRegistrationState();
            modem.closeGracefully(function(){
                process.exit(0);
            });
        });


        modem.startProcessing();

        modem.on('discarding', function(buf){
           console.log("discarding", buf.toString());
        });

        modem.subscribeToNetworkRegistrationState((state) => {
            switch(state){
                case CREG.NotRegisteredNotSearching:
                    console.log("Network registration state: Not registered, not searching");
                    break;

                case CREG.RegisteredHome:
                    console.log('Network registration state: Registered (home network)');
                    break;

                case CREG.NotRegisteredButSearching:
                    console.log('Network registration state: Not registered, but searching');
                    break;

                case CREG.RegistrationDenied:
                    console.log('Network registration state: Registration denied');
                    break;

                case CREG.Unknown:
                    console.log('Network registration state: unknown');
                    break;

                case CREG.RegisteredRoaming:
                    console.log('Network registration state: Registered (roaming)');
                    break;

            }
        });


        modem.enableSMS((pdu, destinationNumber, pduLen) => {
            console.log("Received SMS", destinationNumber, pduLen);

            console.log("Text", pdu.text.toString());
        });

    });


### Networking

#### Sockets

    var TelitModem = require('telit-modem');

    var modem = new TelitModem.TelitModem();

    modem.open('COM4').catch((err) => {
        console.error("Failed to open serial port", err);
    }).then(() => {
        console.log("Opened serial port");

        process.on('SIGINT', function () {
            modem.disablePDP();
            modem.closeGracefully(function(){
                process.exit(0);
            });
        });


        modem.startProcessing();

        modem.on('discarding', function(buf){
           console.log("discarding", buf.toString());
        });


        modem.disablePDP().then(function () {
            console.log("deinitialized PDP");

            modem.setAPN("\"myAPN\"");

            setTimeout(function () { // wait 2 seconds before enabling PDP (again)
                modem.enablePDP().then((ip) => {
                    console.log('connected with IP', ip);

                    var sock = modem.getSocket();
                    sock.connect({
                        host: "whois.internic.ch",
                        port: 43,
                        transportProtocol: TelitModem.Protocols.TCP
                    }, function () {
                        console.log("Connected..");

                        sock.on('data', (data) => {
                            console.log("Response", data.toString());
                            modem.close();
                        });

                        console.log("Querying for the registrar of godzilla.com");
                        sock.write("godzilla.com\r\n");
                    });
                });
            }, 2000);
        });
    });


#### HTTP requests

    var TelitModem = require('telit-modem').TelitModem;

    var modem = new TelitModem();

    modem.open('COM4').catch((err) => {
        console.error("Failed to open serial port", err);
    }).then(() => {

        process.on('SIGINT',function(){
            modem.disablePDP();
            modem.closeGracefully(function(){
                process.exit(0);
            });
        });


        modem.startProcessing();

        modem.on('discarding', function(buf){
            console.log("discarding", buf.toString());
        });

        modem.disablePDP().then(function() {
            console.log("deinitialized PDP");

            modem.setAPN("\"myAPN\"");

            setTimeout(function(){ // wait 2 seconds before enabling PDP (again)
                modem.enablePDP().then((ip) => {
                    console.log('connected with IP', ip);

                var url = 'http://google.ch/robots.txt';
                console.log("GET "+url);
                modem.http().get(url, (res) => {
                    console.log('Response:');

                    res.on('data', (ch) => console.log('ch', ch.toString("ascii")));

                    res.socket.close();

                    modem.close();
                    });
                });
            }, 2000);
        });

    });

