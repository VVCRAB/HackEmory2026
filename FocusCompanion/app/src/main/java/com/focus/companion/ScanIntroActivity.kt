package com.focus.companion

import android.Manifest
import android.content.Intent
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.net.Uri
import androidx.activity.OnBackPressedCallback
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ScanIntroActivity : AppCompatActivity() {
    companion object {
        const val EXTRA_OPEN_SCANNER = "open_scanner"
    }

    private val pairingHandler = Handler(Looper.getMainLooper())
    private lateinit var pairingPrefs: SharedPreferences
    private var pendingRevision: String? = null
    private val pairingListener = SharedPreferences.OnSharedPreferenceChangeListener { prefs, key ->
        if (key == AppBlockerService.PAIRING_ACK &&
            pendingRevision != null && prefs.getString(key, null) == pendingRevision
        ) {
            pendingRevision = null
            pairingHandler.removeCallbacksAndMessages(null)
            startActivity(Intent(this, ConnectedActivity::class.java))
            finish()
        }
    }

    private lateinit var cameraExecutor: ExecutorService
    @Volatile private var pairingSaved = false
    @Volatile private var isScanning = false
    private var cameraProvider: ProcessCameraProvider? = null
    private var scanGeneration = 0
    private val scanBack = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = cancelScan()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pairingPrefs = getSharedPreferences(AppBlockerService.PREFS, MODE_PRIVATE)
        pairingPrefs.registerOnSharedPreferenceChangeListener(pairingListener)
        cameraExecutor = Executors.newSingleThreadExecutor()
        onBackPressedDispatcher.addCallback(this, scanBack)
        showIntro()
        if (savedInstanceState?.getBoolean(EXTRA_OPEN_SCANNER) ?:
            intent.getBooleanExtra(EXTRA_OPEN_SCANNER, false)) {
            openScanner()
        } else {
            startIntroPreview()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(EXTRA_OPEN_SCANNER, isScanning)
        super.onSaveInstanceState(outState)
    }

    private fun showIntro() {
        setContentView(R.layout.activity_scan_intro)
        applySystemBarInsets(findViewById(R.id.scanIntroRoot))
        findViewById<View>(R.id.btnOpenScanner).setOnClickListener { openScanner() }
    }

    private fun openScanner() {
        if (allPermissionsGranted()) {
            switchToScannerView()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 101)
        }
    }

    private fun allPermissionsGranted() = ContextCompat.checkSelfPermission(
        baseContext, Manifest.permission.CAMERA
    ) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 101 && allPermissionsGranted()) {
            switchToScannerView()
        } else {
            Toast.makeText(this, "Camera permission is required to scan the QR code.", Toast.LENGTH_SHORT).show()
        }
    }

    private fun switchToScannerView() {
        stopScanner()
        setContentView(R.layout.activity_qr_scanner)
        applySystemBarInsets(findViewById(R.id.scanRoot))
        val viewFinder = findViewById<PreviewView>(R.id.viewFinder)
        if (viewFinder == null) {
            Log.e("FocusQR", "Scanner layout is missing its camera preview")
            Toast.makeText(this, "Camera preview unavailable.", Toast.LENGTH_SHORT).show()
            return
        }
        viewFinder.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        isScanning = true
        scanBack.isEnabled = true
        val generation = ++scanGeneration
        findViewById<View>(R.id.btnCancelScan).setOnClickListener { cancelScan() }
        startCamera(viewFinder, generation)
    }

    private fun cancelScan() {
        pendingRevision = null
        pairingSaved = false
        pairingHandler.removeCallbacksAndMessages(null)
        stopScanner()
        showIntro()
        startIntroPreview()
    }

    private fun startIntroPreview() {
        if (!allPermissionsGranted()) return
        val preview = findViewById<PreviewView>(R.id.viewFinder) ?: return
        preview.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        startCamera(preview, ++scanGeneration, analyze = false)
    }

    private fun stopScanner() {
        isScanning = false
        scanGeneration++
        scanBack.isEnabled = false
        cameraProvider?.unbindAll()
        cameraProvider = null
    }

    private fun startCamera(viewFinder: PreviewView, generation: Int, analyze: Boolean = true) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)

        cameraProviderFuture.addListener({
            if (generation != scanGeneration || isFinishing || isDestroyed) return@addListener
            try {
                val provider = cameraProviderFuture.get()
                cameraProvider = provider
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(viewFinder.surfaceProvider)
                }

                provider.unbindAll()
                if (!analyze) {
                    provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview)
                    return@addListener
                }

                val imageAnalyzer = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also {
                        it.setAnalyzer(cameraExecutor) { imageProxy ->
                            processImageProxy(imageProxy, generation)
                        }
                    }

                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageAnalyzer)
            } catch (error: Exception) {
                Log.e("FocusQR", "Camera binding failed", error)
                Toast.makeText(this, "Could not start the camera.", Toast.LENGTH_SHORT).show()
                if (analyze) cancelScan() else stopScanner()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @OptIn(ExperimentalGetImage::class)
    private fun processImageProxy(imageProxy: ImageProxy, generation: Int) {
        if (pairingSaved || !isScanning) {
            imageProxy.close()
            return
        }

        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            val scanner = BarcodeScanning.getClient()

            scanner.process(image)
                .addOnSuccessListener { barcodes ->
                    if (!isScanning || generation != scanGeneration || pairingSaved) return@addOnSuccessListener
                    for (barcode in barcodes) {
                        val rawValue = barcode.rawValue
                        if (rawValue != null && (rawValue.contains("ws://") || rawValue.contains("wss://"))) {
                            pairingSaved = true
                            parseAndConnect(rawValue)
                            break
                        }
                    }
                }
                .addOnCompleteListener {
                    imageProxy.close()
                }
        } else {
            imageProxy.close()
        }
    }

    private fun parseAndConnect(qrPayload: String) {
        try {
            val pairing = JSONObject(qrPayload)
            val url = pairing.getString("url")
            val code = pairing.optString("code", pairing.optString("token"))
            require(code.matches(Regex("[0-9]{4}")))
            val address = Uri.parse(url)
            require(address.scheme in listOf("ws", "wss") && !address.host.isNullOrBlank())
            val revision = java.util.UUID.randomUUID().toString()
            pendingRevision = revision
            pairingPrefs.edit()
                .putString(AppBlockerService.URL, url)
                .putString(AppBlockerService.CODE, code)
                .putString(AppBlockerService.PAIRING_REVISION, revision)
                .apply()

            Toast.makeText(this, "Connecting to desktop…", Toast.LENGTH_SHORT).show()
            pairingHandler.postDelayed({
                if (pendingRevision == revision) {
                    pendingRevision = null
                    pairingSaved = false
                    cancelScan()
                    Toast.makeText(this, "Desktop did not confirm pairing. Check Wi-Fi and scan a fresh QR code.", Toast.LENGTH_LONG).show()
                }
            }, 15000)
        } catch (error: Exception) {
            Log.w("FocusQR", "Invalid pairing QR", error)
            pairingSaved = false
        }
    }

    override fun onDestroy() {
        pairingPrefs.unregisterOnSharedPreferenceChangeListener(pairingListener)
        pairingHandler.removeCallbacksAndMessages(null)
        stopScanner()
        cameraExecutor.shutdown()
        super.onDestroy()
    }
}
