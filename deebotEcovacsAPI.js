const ecovacsDeebot = require('ecovacs-deebot'),
  nodeMachineId = require('node-machine-id'),
  countries = ecovacsDeebot.countries,
  EcoVacsAPI = ecovacsDeebot.EcoVacsAPI;

var EventEmitter = require('events');
var inherits = require('util').inherits;

module.exports = {
  DeebotEcovacsAPI: DeebotEcovacsAPI,
};

function DeebotEcovacsAPI(log, platform) {
  EventEmitter.call(this);

  this.log = log;
  this.platform = platform;
  this.login = platform.login;
  this.countryCode = platform.countryCode.toUpperCase();
  this.device_id = EcoVacsAPI.md5(nodeMachineId.machineIdSync());
  this.password_hash = EcoVacsAPI.md5(platform.password);
  this.continent = countries[this.countryCode].continent.toUpperCase();
  this.deebotNames = platform.deebotNames;

  this.log('INFO - API :' + this.continent + '/' + this.countryCode);

  this.api = new EcoVacsAPI(this.device_id, this.countryCode, this.continent);

  this.vacbots = [];
}

DeebotEcovacsAPI.prototype = {
  getDeebots: function () {
    this.api
      .connect(this.login, this.password_hash)
      .then(() => {
        this.log.debug('INFO - connected');
        this.api.devices().then((devices) => {
          this.log.debug('INFO - getDeebots :', JSON.stringify(devices));

          for (let s = 0; s < devices.length; s++) {
            let vacuum = devices[s]; // Selects the first vacuum from your account
            let foundDeebotName = vacuum.nick ? vacuum.nick : vacuum.name;

            if (
              this.deebotNames == undefined ||
              this.deebotNames.length == 0 ||
              this.deebotNames.includes(foundDeebotName)
            ) {
              const vacbot = this.api.getVacBot(
                this.api.uid,
                EcoVacsAPI.REALM,
                this.api.resource,
                this.api.user_access_token,
                vacuum,
                this.continent
              );
              this.vacbots.push(vacbot);
            }
          }

          this.emit('deebotsDiscovered');
        });
      })
      .catch((e) => {
        // The Ecovacs API endpoint is not very stable, so
        // connecting fails randomly from time to time
        this.log('ERROR - Failure in connecting to ecovacs to retrieve your deebots! - ' + e);
        this.emit('errorDiscoveringDeebots');
      });
  },

  configureEvents: function (deebotAccessory) {
    var Characteristic = this.platform.api.hap.Characteristic;

    const vacBot = deebotAccessory.vacBot;

    vacBot.on('ready', (event) => {
      this.log.debug('INFO - Vacbot ' + deebotAccessory.name + ' ready: ' + JSON.stringify(event));

      vacBot.run('GetCleanState');
      vacBot.run('GetBatteryState');
      vacBot.run('GetChargeState');
      vacBot.run('GetCleanSpeed');

      if (vacBot.hasSpotAreaCleaningMode()) {
        vacBot.run('GetMaps');
      }

      if (vacBot.orderToSend && vacBot.orderToSend !== undefined) {
        this.log('INFO - sendingCommand ' + vacBot.orderToSend + ' to ' + deebotAccessory.name);

        if (vacBot.orderToSend instanceof Array) {
          vacBot.run.apply(vacBot, orderToSend);
        } else {
          vacBot.run(vacBot.orderToSend);
        }

        vacBot.orderToSend = undefined;
      }
    });

    vacBot.on('BatteryInfo', (battery) => {
      vacBot.errorInprogress = false;

      let batteryLevel = this.platform.getBatteryLevel(battery);
      let currentValue = deebotAccessory.HKBatteryService.getCharacteristic(
        Characteristic.BatteryLevel
      ).value;

      this.log.debug(
        'INFO - Battery level for ' + deebotAccessory.name + ' : %d %d %d',
        battery,
        batteryLevel,
        currentValue
      );

      if (currentValue !== batteryLevel) {
        deebotAccessory.HKBatteryService.getCharacteristic(Characteristic.BatteryLevel).updateValue(
          batteryLevel
        );
        if (batteryLevel < 20)
          deebotAccessory.HKBatteryService.getCharacteristic(
            Characteristic.StatusLowBattery
          ).updateValue(1);
        else
          deebotAccessory.HKBatteryService.getCharacteristic(
            Characteristic.StatusLowBattery
          ).updateValue(0);
      }
    });

    vacBot.on('ChargeState', (charge_status) => {
      vacBot.errorInprogress = false;

      let charging = charge_status == 'charging';
      let idle = charge_status == 'idle';
      let returning = charge_status == 'returning';
      this.log.debug(
        'INFO - Charge status for ' + deebotAccessory.name + ' : %s %s %s',
        charge_status,
        idle,
        charging
      );

      let currentValue = deebotAccessory.HKBatteryService.getCharacteristic(
        Characteristic.ChargingState
      ).value;

      if (currentValue !== charging) {
        deebotAccessory.HKBatteryService.getCharacteristic(
          Characteristic.ChargingState
        ).updateValue(charging);
      }

      if (deebotAccessory.HKFanService != undefined) {
        let currentOnValue = deebotAccessory.HKFanService.getCharacteristic(Characteristic.On)
          .value;
        if (charging && currentOnValue) {
          deebotAccessory.HKFanService.getCharacteristic(Characteristic.On).updateValue(false);
        } else if (returning && !currentOnValue) {
          deebotAccessory.HKFanService.getCharacteristic(Characteristic.On).updateValue(true);
        }
      }

      if (deebotAccessory.HKSwitchOnService != undefined) {
        let currentMainOnValue = deebotAccessory.HKSwitchOnService.getCharacteristic(
          Characteristic.On
        ).value;
        if (charging && currentMainOnValue) {
          deebotAccessory.HKSwitchOnService.getCharacteristic(Characteristic.On).updateValue(false);
        } else if (idle && !currentMainOnValue) {
          deebotAccessory.HKSwitchOnService.getCharacteristic(Characteristic.On).updateValue(true);
        }
      }
    });

    vacBot.on('CleanReport', (clean_status) => {
      vacBot.errorInprogress = false;

      this.log.debug('INFO - Clean status for ' + deebotAccessory.name + ' : %s', clean_status);

      if (clean_status) {
        let cleaning = clean_status != 'stop' && clean_status != 'pause' && clean_status != 'idle';

        if (deebotAccessory.HKFanService != undefined) {
          let currentOnValue = deebotAccessory.HKFanService.getCharacteristic(Characteristic.On)
            .value;
          if (currentOnValue !== cleaning) {
            deebotAccessory.HKFanService.getCharacteristic(Characteristic.On).updateValue(cleaning);
            vacBot.run('GetCleanSpeed'); // to update speed accordingly.
          }
        }

        if (deebotAccessory.HKSwitchOnService) {
          let currentMainOnValue = deebotAccessory.HKSwitchOnService.getCharacteristic(
            Characteristic.On
          ).value;
          if (cleaning && !currentMainOnValue)
            deebotAccessory.HKSwitchOnService.getCharacteristic(Characteristic.On).updateValue(
              true
            );
        }

        //could handle clean status to update switches .... (spotArea, cleaning mode ... ???)
      }
    });

    vacBot.on('CleanSpeed', (clean_speed) => {
      vacBot.errorInprogress = false;
      if (deebotAccessory.HKFanService != undefined) {
        let currentSpeedValue = deebotAccessory.HKFanService.getCharacteristic(
          Characteristic.RotationSpeed
        ).value;
        let deebotSpeed = this.platform.getCleanSpeed(currentSpeedValue);

        this.log.debug(
          'INFO - Clean speed fro ' + deebotAccessory.name + ' : %s - %s',
          clean_speed,
          deebotSpeed
        );

        if (deebotSpeed !== clean_speed) {
          let newSpeed = this.platform.getFanSpeed(clean_speed);
          deebotAccessory.HKFanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(
            newSpeed
          );
        }
      }
    });

    vacBot.on('Error', (error_message) => {
      this.log.debug(
        'INFO - Error from deebot ' +
          deebotAccessory.name +
          '(ready : ' +
          vacBot.is_ready +
          ')' +
          ' : %s ',
        error_message
      );
      if (error_message) {
        if (error_message.indexOf('Timeout') > -1) {
          //an order might have been lost, so we update

          if (!vacBot.errorInprogress) {
            vacBot.errorInprogress = true;
            vacBot.run('GetCleanState');
            vacBot.run('GetBatteryState');
            vacBot.run('GetChargeState');
            vacBot.run('GetCleanSpeed');
          }
        } else if (deebotAccessory.HKMotionService != undefined) {
          let isOnError = error_message.indexOf('NoError') == -1;
          this.log.debug(
            'INFO - updating sensor for ' + deebotAccessory.name + ' : %s ',
            isOnError
          );

          deebotAccessory.HKMotionService.getCharacteristic(
            Characteristic.MotionDetected
          ).updateValue(isOnError);
        }
      }
    });

    vacBot.on('message', (message) => {
      this.log.debug('INFO - Message from deebot ' + deebotAccessory.name + ' : %s ', message);
    });

    vacBot.on('disconnect', (error) => {
      if (error) {
        this.log('WARNING - Message from deebot ' + deebotAccessory.name + ' : %s ', error);
      }
      vacBot.disconnect();
      vacBot.connect();
    });

    if (this.platform.showInfoLogs) {
      vacBot.on('LastUsedAreaValues', (values) => {
        this.log('INFO - LastUsedAreaValues ' + values + ' for ' + deebotAccessory.name);
      });
      vacBot.on('Maps', (maps) => {
        this.log('INFO - Maps ' + JSON.stringify(maps) + ' for ' + deebotAccessory.name);
        for (const i in maps['maps']) {
          const mapID = maps['maps'][i]['mapID'];
          vacBot.run('GetSpotAreas', mapID);
          vacBot.run('GetVirtualBoundaries', mapID);
        }
      });
      vacBot.on('MapSpotAreas', (spotAreas) => {
        this.log(
          'INFO - MapSpotAreas ' + JSON.stringify(spotAreas) + ' for ' + deebotAccessory.name
        );
        for (const i in spotAreas['mapSpotAreas']) {
          const spotAreaID = spotAreas['mapSpotAreas'][i]['mapSpotAreaID'];
          vacBot.run('GetSpotAreaInfo', spotAreas['mapID'], spotAreaID);
        }
      });
      vacBot.on('MapSpotAreaInfo', (area) => {
        this.log('INFO - MapSpotAreaInfo ' + JSON.stringify(area) + ' for ' + deebotAccessory.name);
      });
      vacBot.on('MapVirtualBoundaries', (virtualBoundaries) => {
        this.log(
          'INFO - MapVirtualBoundaries ' +
            JSON.stringify(virtualBoundaries) +
            ' for ' +
            deebotAccessory.name
        );

        const mapID = virtualBoundaries['mapID'];
        const virtualBoundariesCombined = [
          ...virtualBoundaries['mapVirtualWalls'],
          ...virtualBoundaries['mapNoMopZones'],
        ];
        const virtualBoundaryArray = [];
        for (const i in virtualBoundariesCombined) {
          virtualBoundaryArray[virtualBoundariesCombined[i]['mapVirtualBoundaryID']] =
            virtualBoundariesCombined[i];
        }
        for (const i in virtualBoundaryArray) {
          const mapVirtualBoundaryID = virtualBoundaryArray[i]['mapVirtualBoundaryID'];
          const mapVirtualBoundaryType = virtualBoundaryArray[i]['mapVirtualBoundaryType'];
          vacBot.run('GetVirtualBoundaryInfo', mapID, mapVirtualBoundaryID, mapVirtualBoundaryType);
        }
      });
      vacBot.on('MapVirtualBoundaryInfo', (virtualBoundary) => {
        this.log(
          'INFO - MapVirtualBoundaryInfo ' +
            JSON.stringify(virtualBoundary) +
            ' for ' +
            deebotAccessory.name
        );
      });
      vacBot.on('CurrentMapName', (value) => {
        this.log('INFO - CurrentMapName ' + value + ' for ' + deebotAccessory.name);
      });
      vacBot.on('CurrentMapMID', (mapID) => {
        this.log('INFO - CurrentMapMID ' + mapID + ' for ' + deebotAccessory.name);
        vacBot.run('GetSpotAreas', mapID);
      });
      vacBot.on('CurrentMapIndex', (value) => {
        this.log('INFO - CurrentMapIndex ' + value + ' for ' + deebotAccessory.name);
      });
    }

    vacBot.connect();
  },
};
DeebotEcovacsAPI.prototype.GetSpotAreas = function (vacBot, mapID) {
    return new Promise((resolve, reject) => {
        vacBot.run('GetSpotAreas', mapID, (err, areas) => {
            if (err) {
                this.log('ERROR - Unable to fetch spot areas: ' + err);
                return reject(err);
            }
            this.log('INFO - Retrieved Spot Areas: ' + JSON.stringify(areas));
            resolve(areas);
        });
    });
};

// Keep the inherits line here
inherits(DeebotEcovacsAPI, EventEmitter);

inherits(DeebotEcovacsAPI, EventEmitter);
