/* global alert */
import React, { useState } from 'react';
import { FlatList, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BlueButton, BlueButtonLink, BlueCard, BlueNavigationStyle, BlueSpacing20, BlueText, SafeBlueArea } from '../../BlueComponents';
import { DynamicQRCode } from '../../components/DynamicQRCode';
import { SquareButton } from '../../components/SquareButton';
import { getSystemName } from 'react-native-device-info';
import { decodeUR, extractSingleWorkload } from 'bc-ur/dist';
import loc from '../../loc';
import { BlueCurrentTheme } from '../../components/themes';
import { Icon } from 'react-native-elements';
import ImagePicker from 'react-native-image-picker';
import ScanQRCode from './ScanQRCode';
import { useNavigation, useRoute } from '@react-navigation/native';

const BlueApp = require('../../BlueApp');
const bitcoin = require('bitcoinjs-lib');
const currency = require('../../blue_modules/currency');
const fs = require('../../blue_modules/fs');
const LocalQRCode = require('@remobile/react-native-qrcode-local-image');
const isDesktop = getSystemName() === 'Mac OS X';
const BigNumber = require('bignumber.js');

const shortenAddress = addr => {
  return addr.substr(0, Math.floor(addr.length / 2) - 1) + '\n' + addr.substr(Math.floor(addr.length / 2) - 1, addr.length);
};

const PsbtMultisig = () => {
  const navigation = useNavigation();
  const route = useRoute();

  const walletId = route.params.walletId;
  const psbtBase64 = route.params.psbtBase64;
  const memo = route.params.memo;

  const [psbt, setPsbt] = useState(bitcoin.Psbt.fromBase64(psbtBase64));
  const [animatedQRCodeData, setAnimatedQRCodeData] = useState({});
  const [isModalVisible, setIsModalVisible] = useState(false);

  /** @type MultisigHDWallet */
  const wallet = BlueApp.getWallets().find(w => w.getID() === walletId);
  let destination = [];
  let totalSat = 0;
  const targets = [];
  for (const output of psbt.txOutputs) {
    if (output.address && !wallet.weOwnAddress(output.address)) {
      totalSat += output.value;
      destination.push(output.address);
      targets.push({ address: output.address, value: output.value });
    }
  }
  destination = shortenAddress(destination.join(', '));
  const totalBtc = new BigNumber(totalSat).dividedBy(100000000).toNumber();
  const totalFiat = currency.satoshiToLocalCurrency(totalSat);

  const fileName = `${Date.now()}.psbt`;

  const howManySignaturesWeHave = () => {
    let sigsHave = 0;
    for (const inp of psbt.data.inputs) {
      sigsHave = Math.max(sigsHave, inp?.partialSig?.length || 0);
      if (inp.finalScriptSig || inp.finalScriptWitness) sigsHave = wallet.getM(); // hacky
    }

    return sigsHave;
  };

  const getFee = () => {
    let goesIn = 0;
    for (const inp of psbt.data.inputs) {
      if (inp.witnessUtxo && inp.witnessUtxo.value) goesIn += inp.witnessUtxo.value;
    }

    let goesOut = 0;
    for (const output of psbt.txOutputs) {
      goesOut += output.value;
    }

    return goesIn - goesOut;
  };

  const _renderItem = el => {
    if (el.index >= howManySignaturesWeHave()) return _renderItemUnsigned(el);
    else return _renderItemSigned(el);
  };

  const _renderItemUnsigned = el => {
    const renderProvideSignature = el.index === howManySignaturesWeHave();
    return (
      <View>
        <View style={styles.itemUnsignedWrapper}>
          <View style={styles.vaultKeyCircle}>
            <Text style={styles.vaultKeyText}>{el.index + 1}</Text>
          </View>
          <View style={styles.vaultKeyTextWrapper}>
            <Text style={styles.vaultKeyText}>Vault key {el.index + 1}</Text>
          </View>
        </View>

        {renderProvideSignature && (
          <View>
            <TouchableOpacity
              style={styles.provideSignatureButton}
              onPress={() => {
                setIsModalVisible(true);
              }}
            >
              <Text style={styles.provideSignatureButtonText}>Provide signature</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  const _renderItemSigned = el => {
    return (
      <View style={styles.flexDirectionRow}>
        <Icon size={58} name="check-circle" type="font-awesome" color="#37C0A1" />
        <View style={styles.vaultKeyTextSignedWrapper}>
          <Text style={styles.vaultKeyTextSigned}>Vault key {el.index + 1}</Text>
        </View>
      </View>
    );
  };

  const _onReadUniformResource = ur => {
    try {
      const [index, total] = extractSingleWorkload(ur);
      animatedQRCodeData[index + 'of' + total] = ur;
      if (Object.values(animatedQRCodeData).length === total) {
        const payload = decodeUR(Object.values(animatedQRCodeData));
        const psbtB64 = Buffer.from(payload, 'hex').toString('base64');
        _combinePSBT(psbtB64);
      } else {
        setAnimatedQRCodeData(animatedQRCodeData);
      }
    } catch (Err) {
      alert('invalid animated QRCode fragment, please try again');
    }
  };

  const _combinePSBT = receivedPSBTBase64 => {
    const receivedPSBT = bitcoin.Psbt.fromBase64(receivedPSBTBase64);
    const newPsbt = psbt.combine(receivedPSBT);
    navigation.dangerouslyGetParent().pop();
    setPsbt(newPsbt);
    setIsModalVisible(false);
  };

  const onBarScanned = ret => {
    if (ret && !ret.data) ret = { data: ret };
    if (ret.data.toUpperCase().startsWith('UR')) {
      return _onReadUniformResource(ret.data);
    } else if (ret.data.indexOf('+') === -1 && ret.data.indexOf('=') === -1 && ret.data.indexOf('=') === -1) {
      // this looks like NOT base64, so maybe its transaction's hex
      alert('This looks like txhex, which is not supported');
    } else {
      // psbt base64?
      _combinePSBT(ret.data);
    }
  };

  const onConfirm = () => {
    try {
      psbt.finalizeAllInputs();
    } catch (_) {} // ignore if it is already finalized

    try {
      const tx = psbt.extractTransaction().toHex();
      const satoshiPerByte = Math.round(getFee() / (tx.length / 2));
      navigation.navigate('Confirm', {
        fee: new BigNumber(getFee()).dividedBy(100000000).toNumber(), // fixme
        memo: memo,
        fromWallet: wallet,
        tx,
        recipients: targets,
        satoshiPerByte,
        // payjoinUrl: this.state.payjoinUrl,
        // psbt: this.state.psbt, // not really needed // fixme
      });
    } catch (error) {
      alert(error);
    }
  };

  const openScanner = () => {
    if (isDesktop) {
      ImagePicker.launchCamera(
        {
          title: null,
          mediaType: 'photo',
          takePhotoButtonTitle: null,
        },
        response => {
          if (response.uri) {
            const uri = Platform.OS === 'ios' ? response.uri.toString().replace('file://', '') : response.path.toString();
            LocalQRCode.decode(uri, (error, result) => {
              if (!error) {
                onBarScanned(result);
              } else {
                alert(loc.send.qr_error_no_qrcode);
              }
            });
          } else if (response.error) {
            ScanQRCode.presentCameraNotAuthorizedAlert(response.error);
          }
        },
      );
    } else {
      navigation.navigate('ScanQRCodeRoot', {
        screen: 'ScanQRCode',
        params: {
          onBarScanned: onBarScanned,
          showFileImportButton: true,
        },
      });
    }
  };

  const exportPSBT = async () => {
    await fs.writeFileAndExport(fileName, psbt.toBase64());
  };

  const isConfirmEnabled = () => {
    return howManySignaturesWeHave() >= wallet.getM();
  };

  const renderDynamicQrCode = () => {
    return (
      <SafeBlueArea style={styles.root}>
        <ScrollView centerContent contentContainerStyle={styles.scrollViewContent}>
          <View style={styles.modalContentShort}>
            <DynamicQRCode value={psbt.toHex()} capacity={666} />
            <BlueSpacing20 />
            <SquareButton backgroundColor="#EEF0F4" onPress={openScanner} title="Scan or import file" />
            <BlueSpacing20 />
            <SquareButton backgroundColor="#EEF0F4" onPress={exportPSBT} title="Share" />
            <BlueSpacing20 />
            <BlueButtonLink title="Cancel" onPress={() => setIsModalVisible(false)} />
          </View>
        </ScrollView>
      </SafeBlueArea>
    );
  };

  if (isModalVisible) return renderDynamicQrCode();

  return (
    <SafeBlueArea style={styles.root}>
      <ScrollView centerContent contentContainerStyle={styles.scrollViewContent}>
        <View style={styles.container}>
          <View style={styles.containerText}>
            <BlueText style={styles.textBtc}>{totalBtc}</BlueText>
            <View style={styles.textBtcUnit}>
              <BlueText> BTC</BlueText>
            </View>
          </View>
          <View style={styles.containerText}>
            <BlueText style={styles.textFiat}>{totalFiat}</BlueText>
          </View>
          <View style={styles.containerText}>
            <BlueText style={styles.textDestination}>{destination}</BlueText>
          </View>

          <BlueCard>
            <FlatList data={new Array(wallet.getM())} renderItem={_renderItem} keyExtractor={(_item, index) => `${index}`} />
          </BlueCard>
        </View>

        <View style={styles.bottomWrapper}>
          <View style={styles.bottomFeesWrapper}>
            <BlueText style={styles.feeFiatText}>Fee: {currency.satoshiToLocalCurrency(getFee())} - </BlueText>
            <BlueText>{currency.satoshiToBTC(getFee())} BTC</BlueText>
          </View>
          <BlueButton disabled={!isConfirmEnabled()} title="Confirm" onPress={onConfirm} />
        </View>
      </ScrollView>
    </SafeBlueArea>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BlueCurrentTheme.colors.elevated,
  },
  scrollViewContent: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  container: {
    flexDirection: 'column',
    justifyContent: 'center',
  },
  containerText: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  textFiat: {
    color: 'gray',
    fontSize: 16,
    fontWeight: '500',
  },
  textBtc: {
    fontWeight: 'bold',
    fontSize: 30,
    color: BlueCurrentTheme.colors.foregroundColor,
  },
  textDestination: {
    paddingTop: 10,
    color: BlueCurrentTheme.colors.foregroundColor,
    paddingBottom: 40,
  },
  bottomModal: {
    justifyContent: 'flex-end',
    margin: 0,
  },
  modalContentShort: {
    backgroundColor: BlueCurrentTheme.colors.elevated,
    marginLeft: 20,
    marginRight: 20,
  },
  copyToClipboard: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  provideSignatureButton: {
    marginTop: 20,
    backgroundColor: '#EEF0F4',
    height: 60,
    borderRadius: 10,
    flex: 1,
    justifyContent: 'center',
    paddingLeft: 15,
    marginBottom: 30,
  },
  provideSignatureButtonText: { color: '#0C2550', fontWeight: 'normal', fontSize: 18 },
  vaultKeyText: { fontSize: 20, fontWeight: 'bold', color: '#9AA0AA' },
  vaultKeyTextWrapper: { justifyContent: 'center', alignItems: 'center', paddingLeft: 15 },
  vaultKeyCircle: {
    backgroundColor: '#EEF0F4',
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  itemUnsignedWrapper: { flexDirection: 'row', paddingTop: 10 },
  vaultKeyTextSigned: { fontSize: 20, fontWeight: 'bold', color: '#37C0A1' },
  vaultKeyTextSignedWrapper: { justifyContent: 'center', alignItems: 'center', paddingLeft: 15 },
  flexDirectionRow: { flexDirection: 'row' },
  textBtcUnit: { justifyContent: 'flex-end', bottom: 5 },
  feeFiatText: { color: 'gray' },
  bottomFeesWrapper: { flexDirection: 'row', paddingBottom: 20 },
  bottomWrapper: { justifyContent: 'center', alignItems: 'center', paddingBottom: 20 },
});

PsbtMultisig.navigationOptions = () => ({
  ...BlueNavigationStyle(null, false),
  title: loc.send.header,
});

export default PsbtMultisig;
