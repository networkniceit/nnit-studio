import React from 'react';
import {
  ActivityIndicator,
  Platform,
  StatusBar as NativeStatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';

const STUDIO_URL = 'https://nnit-studioweb-production.up.railway.app';

export default function Home() {
  const androidTop =
    Platform.OS === 'android' ? NativeStatusBar.currentHeight ?? 0 : 0;

  return (
    <View style={[styles.container, { paddingTop: androidTop }]}>
      <StatusBar
        style="light"
        backgroundColor="#0b0d12"
        translucent={false}
      />

      <WebView
        source={{ uri: STUDIO_URL }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        startInLoadingState
        cacheEnabled={false}
        incognito={false}
        renderLoading={() => (
          <View style={styles.loading}>
            <ActivityIndicator size="large" />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0d12',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0b0d12',
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b0d12',
  },
});
