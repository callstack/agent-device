import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG = 'AdTrajDriver';
const HILOG_DOMAIN = 0x0000;

/**
 * The harness host page doubles as the injection oracle: injected touches land here while the
 * test runs in the same process, the canvas echoes the stroke, and the sampled point count goes
 * to hilog on every lift.
 */
@Entry
@Component
struct Index {
  @State strokeCount: number = 0;
  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private canvasContext: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);
  private samplesInStroke: number = 0;

  build() {
    Column() {
      Text(`strokes: ${this.strokeCount}`)
        .fontSize(18)
        .fontColor('#FFFFFF')
        .margin(12)
      Canvas(this.canvasContext)
        .width('100%')
        .layoutWeight(1)
        .onTouch((event: TouchEvent) => {
          if (event.type === TouchType.Down) {
            this.canvasContext.clearRect(0, 0, 10000, 10000);
            this.samplesInStroke = 1;
            const first = event.touches[0];
            this.canvasContext.beginPath();
            this.canvasContext.moveTo(first.x, first.y);
            this.canvasContext.stroke();
          } else if (event.type === TouchType.Move) {
            const point = event.touches[0];
            this.canvasContext.lineTo(point.x, point.y);
            this.canvasContext.stroke();
            this.samplesInStroke += 1;
          } else if (event.type === TouchType.Up) {
            this.strokeCount += 1;
            hilog.info(HILOG_DOMAIN, TAG, `CANVAS_STROKE %{public}d move samples`, this.samplesInStroke);
          }
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#101418')
  }
}
