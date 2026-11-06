@Entry
@Component
struct Index {
  @State strokeDone: boolean = false;
  private settings: RenderingContextSettings = new RenderingContextSettings(true);
  private canvasContext: CanvasRenderingContext2D = new CanvasRenderingContext2D(this.settings);

  build() {
    Column() {
      Text(this.strokeDone ? 'trajectory received' : 'idle')
        .fontSize(18)
        .margin(12)
      Canvas(this.canvasContext)
        .width('100%')
        .layoutWeight(1)
        .onTouch((event: TouchEvent) => {
          if (event.type === TouchType.Down) {
            this.canvasContext.clearRect(0, 0, 10000, 10000);
            this.strokeDone = false;
            const first = event.touches[0];
            this.canvasContext.beginPath();
            this.canvasContext.moveTo(first.x, first.y);
          } else if (event.type === TouchType.Move) {
            const point = event.touches[0];
            this.canvasContext.lineTo(point.x, point.y);
            this.canvasContext.stroke();
          } else if (event.type === TouchType.Up) {
            this.strokeDone = true;
          }
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#101418')
  }
}
