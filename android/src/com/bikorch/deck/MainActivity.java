package com.bikorch.deck;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Bikorch Deck tablet kabugu: paneli (http://localhost:8787, USB uzerinden PC'den gelir) tam ekran gosterir.
 * Ekran hic kapanmaz; PC hazir degilse bekleme ekrani gosterir ve 3 saniyede bir yeniden dener.
 */
public class MainActivity extends Activity {
    private static final String URL = "http://localhost:8787/";
    private static final String WAITING =
        "<html><body style='margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;"
        + "justify-content:center;background:#0a0c10;color:#f4f5f7;font-family:sans-serif'>"
        + "<div style='font-size:5vw;letter-spacing:.3em;font-weight:700'>BIKORCH <span style='color:#8b7cf8'>DECK</span></div>"
        + "<div style='font-size:2.2vw;color:#818a98;margin-top:1.2em'>Bilgisayar bekleniyor&hellip; USB kablosunu ya da Wi-Fi bağlantısını kontrol et</div>"
        + "</body></html>";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable retry = new Runnable() {
        @Override public void run() { web.loadUrl(URL); }
    };
    private WebView web;
    private PermissionRequest pending; // kamera izni beklenirken panelin istegi

    // Panel yalnizca kamerayi isteyebilir (nobet modu); baska kaynak verilmez.
    private void grantCamera(PermissionRequest r) {
        boolean cam = false;
        for (String res : r.getResources()) if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) cam = true;
        if (!cam) { r.deny(); return; }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            r.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        } else {
            pending = r;
            requestPermissions(new String[] { Manifest.permission.CAMERA }, 1);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        if (pending == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pending.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        else pending.deny();
        pending = null;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(10, 12, 16));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false); // "is tamam" sesi dokunmadan calabilsin
        s.setTextZoom(100); // sistem yazi boyutu ayari panel olcegini bozmasin
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                view.loadDataWithBaseURL(null, WAITING, "text/html", "utf-8", null);
                handler.removeCallbacks(retry);
                handler.postDelayed(retry, 3000);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() { @Override public void run() { grantCamera(request); } });
            }
        });
        setContentView(web);
        web.loadUrl(URL);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // Durum ve gezinme cubuklarini gizler; kenardan kaydirinca kisa sureligine geri gelirler.
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { /* geri tusu paneli kapatmasin */ }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(retry);
        web.destroy();
        super.onDestroy();
    }
}
