import React from 'react';
import {
  ActivityIndicator,
  Platform,
  Share,
  StatusBar as NativeStatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

const STUDIO_URL = 'https://nnit-studioweb-production.up.railway.app';

export default function Home() {
  const androidTop =
    Platform.OS === 'android' ? NativeStatusBar.currentHeight ?? 0 : 0;

  const handleMessage = async (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data?.type === 'share') {
        const title = data.title || 'NNIT Studio';
        const message = data.message || '';
        const url = data.url || '';

        await Share.share({
          title,
          message: [message, url].filter(Boolean).join('\n\n'),
          url: Platform.OS === 'ios' ? url : undefined,
        });
      }
    } catch (error) {
      console.warn('NNIT WebView message error:', error);
    }
  };

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
        onMessage={handleMessage}
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