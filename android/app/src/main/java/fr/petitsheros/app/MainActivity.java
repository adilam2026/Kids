package fr.petitsheros.app;

import android.media.AudioManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Les boutons de volume règlent le volume multimédia (celui des sons de l'application), pas la sonnerie.
        setVolumeControlStream(AudioManager.STREAM_MUSIC);
    }
}
