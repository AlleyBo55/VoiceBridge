import { Composition } from 'remotion';
import { VoiceBridgeReel } from './VoiceBridgeReel';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="VoiceBridgeReel"
        component={VoiceBridgeReel}
        durationInFrames={1090} // ~36s at 30fps
        fps={30}
        width={1080}
        height={1920}
      />
    </>
  );
};
