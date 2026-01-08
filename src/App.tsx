import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { Play, Settings2, XCircle, CheckCircle2, Folder, Pause, Square } from 'lucide-react'
import { motion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

type FrameFileInfo = {
  path: string
  width: number
  height: number
  size: number
}

type ScanResult = {
  files: FrameFileInfo[]
  total: number
  allSameSize: boolean
  baseSize: [number, number] | null
}

type ConvertProgressEvent = {
  phase: string
  current: number
  total: number
  percent: number
  format?: string | null
  file?: string | null
}

type ConvertResult = {
  format: string
  path: string
  success: boolean
  error?: string | null
  originalSize?: number | null
  compressedSize?: number | null
}

function getBaseName(path: string): string {
  const parts = path.split(/[/\\]/)
  const fileName = parts[parts.length - 1] || path
  // Remove extension and trailing sequence numbers (e.g., _0001, _001, _01, _1)
  return fileName
    .replace(/\.[^/.]+$/, '')  // Remove extension
    .replace(/[_-]\d+$/, '')   // Remove trailing sequence numbers like _0001, -001
}

export default function App() {
  const [inputPath, setInputPath] = useState<string>('')
  const [inputPaths, setInputPaths] = useState<string[]>([])
  const [isFolder, setIsFolder] = useState<boolean>(false)
  const [outputDir, setOutputDir] = useState<string>('')
  const [outputName, setOutputName] = useState<string>('')
  const [fps, setFps] = useState<string>('30')
  const [loopCount, setLoopCount] = useState<string>('0')
  const [formats, setFormats] = useState<string[]>(['webp'])
  const [useLocalCompression, setUseLocalCompression] = useState<boolean>(true)
  const [compressionQuality, setCompressionQuality] = useState<string>('80')

  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [isConverting, setIsConverting] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState<ConvertProgressEvent | null>(null)
  const [results, setResults] = useState<ConvertResult[]>([])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const dialogInFlightRef = useRef<{ input: boolean; inputFolder: boolean; outputDir: boolean }>({
    input: false,
    inputFolder: false,
    outputDir: false,
  })
  const [isPickingInput, setIsPickingInput] = useState(false)
  const [isPickingInputFolder, setIsPickingInputFolder] = useState(false)
  const [isPickingOutputDir, setIsPickingOutputDir] = useState(false)
  const dialogReqIdRef = useRef<{ input: number; inputFolder: number; outputDir: number }>({
    input: 0,
    inputFolder: 0,
    outputDir: 0,
  })

  const canConvert = useMemo(() => {
    if (isConverting) return false
    if (isFolder) {
      if (!inputPath.trim()) return false
    } else {
      if (!(inputPaths.length || inputPath.trim())) return false
    }
    if (!outputDir.trim()) return false
    if (formats.length === 0) return false
    const fpsNum = Number(fps)
    if (!Number.isFinite(fpsNum) || fpsNum <= 0) return false
    const loopNum = Number(loopCount)
    if (!Number.isFinite(loopNum) || loopNum < 0) return false
    return true
  }, [isConverting, isFolder, inputPath, inputPaths, outputDir, formats, fps, loopCount])

  async function scanFiles(overrideInputPath?: string, overrideInputPaths?: string[], overrideIsFolder?: boolean) {
    const currentInputPath = overrideInputPath !== undefined ? overrideInputPath : inputPath
    const currentInputPaths = overrideInputPaths !== undefined ? overrideInputPaths : inputPaths
    const currentIsFolder = overrideIsFolder !== undefined ? overrideIsFolder : isFolder
    
    if (currentIsFolder && !currentInputPath.trim()) return
    if (!currentIsFolder && !currentInputPaths.length && !currentInputPath.trim()) return

    try {
      const result = await invoke<ScanResult>('scan_frame_files', {
        inputMode: currentIsFolder ? 'folder' : 'file',
        inputPath: currentInputPath,
        inputPaths: !currentIsFolder ? currentInputPaths : null,
      })
      setScanResult(result)
    } catch (error) {
      console.error('Scan error:', error)
    }
  }

  async function pickInput() {
    try {
      if (dialogInFlightRef.current.input) return
      dialogInFlightRef.current.input = true
      setIsPickingInput(true)
      const reqId = ++dialogReqIdRef.current.input

      // Focus window first to ensure dialog is visible
      try {
        await getCurrentWindow().setFocus()
      } catch {
        // Ignore focus errors
      }

      // Open file dialog (supports multiple files)
      const picked = await open({
        directory: false,
        multiple: true,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'] }],
      })
      if (reqId !== dialogReqIdRef.current.input) return

      // If user selected files
      if (picked) {
        const filesRaw = Array.isArray(picked)
          ? picked.filter((x): x is string => typeof x === 'string')
          : typeof picked === 'string'
            ? [picked]
            : []
        const files = Array.from(new Set(filesRaw))
        if (files.length > 0) {
          setInputPaths(files)
          setInputPath(files[0] ?? '')
          setIsFolder(false)
          await scanFiles(files[0] ?? '', files, false)
          return
        }
      }
    } catch (error) {
      console.error('Error picking input:', error)
    } finally {
      dialogInFlightRef.current.input = false
      setIsPickingInput(false)
    }
  }

  async function pickInputFolder() {
    try {
      if (dialogInFlightRef.current.inputFolder) return
      dialogInFlightRef.current.inputFolder = true
      setIsPickingInputFolder(true)
      const reqId = ++dialogReqIdRef.current.inputFolder

      const folderPicked = await open({
        directory: true,
        multiple: false,
      })
      if (reqId !== dialogReqIdRef.current.inputFolder) return

      if (folderPicked) {
        const p = typeof folderPicked === 'string' ? folderPicked : ''
        if (p) {
          setInputPath(p)
          setInputPaths([])
          setIsFolder(true)
          await scanFiles(p, [], true)
        }
      }
    } catch (error) {
      console.error('Error picking folder:', error)
    } finally {
      dialogInFlightRef.current.inputFolder = false
      setIsPickingInputFolder(false)
    }
  }

  async function pickOutputDir() {
    try {
      if (dialogInFlightRef.current.outputDir) return
      dialogInFlightRef.current.outputDir = true
      setIsPickingOutputDir(true)
      const reqId = ++dialogReqIdRef.current.outputDir
      const picked = await open({ directory: true, multiple: false })
      if (reqId !== dialogReqIdRef.current.outputDir) return
      const p = typeof picked === 'string' ? picked : ''
      setOutputDir(p)
    } finally {
      dialogInFlightRef.current.outputDir = false
      setIsPickingOutputDir(false)
    }
  }

  function resetDialogs() {
    dialogInFlightRef.current = { input: false, inputFolder: false, outputDir: false }
    dialogReqIdRef.current.input += 1
    dialogReqIdRef.current.inputFolder += 1
    dialogReqIdRef.current.outputDir += 1
    setIsPickingInput(false)
    setIsPickingInputFolder(false)
    setIsPickingOutputDir(false)
  }

  async function togglePause() {
    if (isPaused) {
      await invoke('resume_conversion')
      setIsPaused(false)
    } else {
      await invoke('pause_conversion')
      setIsPaused(true)
    }
  }

  async function cancelConvert() {
    await invoke('cancel_conversion')
    setIsConverting(false)
    setIsPaused(false)
    setProgress(null)
  }

  async function startConvert() {
    if (!canConvert) {
      return
    }
    setIsConverting(true)
    setIsPaused(false)
    setProgress(null)
    setResults([])

    try {
      const convertResults = await invoke<ConvertResult[]>('convert_sequence_frames', {
        request: {
          inputMode: isFolder ? 'folder' : 'file',
          inputPath,
          inputPaths: !isFolder ? inputPaths : null,
          outputDir: outputDir.trim(),
          outputName: outputName.trim() || null,
          fps: Number(fps),
          loopCount: Number(loopCount),
          formats,
          useLocalCompression,
          compressionQuality: Number(compressionQuality),
        }
      })
      setResults(convertResults)
    } catch (error) {
      console.error('Convert error:', error)
    } finally {
      setIsConverting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    ;(async () => {
      const u1 = await listen<ConvertProgressEvent>('convert-progress', (e) => setProgress(e.payload))
      if (cancelled) {
        u1()
        return
      }
      unsubs.push(u1)
    })()
    return () => {
      cancelled = true
      for (const u of unsubs) u()
    }
  }, [])

  // Auto-generate output name when scanResult changes
  useEffect(() => {
    if (scanResult && scanResult.baseSize) {
      const baseName = isFolder
        ? getBaseName(inputPath)
        : getBaseName(inputPaths[0] || inputPath)
      const newOutputName = `${baseName}_${scanResult.baseSize[0]}x${scanResult.baseSize[1]}`
      setOutputName(newOutputName)
    }
  }, [scanResult, isFolder, inputPath, inputPaths])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMouseDown = async (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('button, input, textarea, a, [data-tauri-drag-region="false"]')) return
      try {
        await getCurrentWindow().startDragging()
      } catch {
        // ignore
      }
    }
    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [])

  const toggleFormat = (format: string) => {
    setFormats((prev) =>
      prev.includes(format) ? prev.filter((f) => f !== format) : [...prev, format]
    )
  }

  const highlightColor = '#55B2F9'
  const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

  const fadeUp = {
    initial: { opacity: 0, y: 36 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.9, ease: EASE_OUT } },
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      <div className="mx-auto h-full w-full max-w-[1280px] overflow-y-auto px-10 pt-[86px] pb-10 no-scrollbar">
        <div className="flex flex-col gap-6">
          <motion.div {...fadeUp} className="flex items-start justify-between">
            <div>
              <div className="text-4xl font-black tracking-tight bg-gradient-to-r from-[#55B2F9] via-[#1E4F9E] to-[#55B2F9] bg-clip-text text-transparent">
                FrameConverter
              </div>
              <div className="mt-1 text-sm text-white/50">
                Convert image sequences to animated WebP, APNG, or GIF
              </div>
            </div>

          </motion.div>

          <motion.div {...fadeUp} className="mt-5 grid w-full grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
            <Card className="h-full flex flex-col bg-white/[0.03]">
              <CardHeader className="pb-12">
                <CardTitle className="flex items-center gap-2">
                  <Settings2 className="h-5 w-5 opacity-70" />
                  Paths
                </CardTitle>
                <CardDescription>Select input files/folder and output directory</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-5">
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Input</div>
                  <div className="flex items-center gap-3">
                    <Input
                      value={inputPath}
                      onChange={(e) => {
                        const v = e.target.value
                        setInputPath(v)
                        if (!isFolder) setInputPaths(v.trim() ? [v] : [])
                        setScanResult(null)
                      }}
                      placeholder="/path/to/files or /path/to/folder"
                    />
                    <div className="flex gap-2">
                      <Button variant="outline" className="h-10" onClick={pickInput} disabled={isPickingInput}>
                        {isPickingInput ? 'Opening…' : 'Browse Files'}
                      </Button>
                      <Button variant="outline" className="h-10" onClick={pickInputFolder} disabled={isPickingInputFolder}>
                        <Folder className="h-4 w-4" />
                        {isPickingInputFolder ? 'Opening…' : 'Browse Folder'}
                      </Button>
                    </div>
                  </div>
                  {(isPickingInput || isPickingInputFolder || isPickingOutputDir) && (
                    <div className="text-xs text-white/50">
                      Dialog seems stuck?{' '}
                      <button
                        type="button"
                        className="underline underline-offset-4 hover:text-white/80"
                        onClick={resetDialogs}
                      >
                        Reset
                      </button>
                    </div>
                  )}
                  {scanResult && (
                    <div className="text-xs text-white/45">
                      Found: <span style={{ color: highlightColor }} className="font-semibold">{scanResult.total}</span> files
                      {scanResult.baseSize && (
                        <span className="ml-2 text-white/35">
                          ({scanResult.baseSize[0]}×{scanResult.baseSize[1]})
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Output Directory</div>
                  <div className="flex items-center gap-3">
                    <Input
                      value={outputDir}
                      onChange={(e) => setOutputDir(e.target.value)}
                      placeholder="/path/to/output"
                    />
                    <Button variant="outline" className="h-10" onClick={pickOutputDir} disabled={isPickingOutputDir}>
                      {isPickingOutputDir ? 'Opening…' : 'Browse'}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Output Name (optional)</div>
                  <Input
                    value={outputName}
                    onChange={(e) => setOutputName(e.target.value)}
                    placeholder="Auto-generated from input name + size"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="h-full flex flex-col bg-white/[0.03]">
              <CardHeader className="pb-12">
                <CardTitle className="flex items-center gap-2">
                  <Settings2 className="h-5 w-5 opacity-70" />
                  Settings
                </CardTitle>
                <CardDescription>Configure animation parameters</CardDescription>
              </CardHeader>
              <CardContent className="flex-1 space-y-5">
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Frame Rate (fps)</div>
                  <Input
                    value={fps}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '')
                      setFps(v)
                    }}
                    placeholder="30"
                  />
                  <div className="text-xs text-white/45">Default: 30 fps</div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Loop Count</div>
                  <Input
                    value={loopCount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9]/g, '')
                      setLoopCount(v)
                    }}
                    placeholder="0"
                  />
                  <div className="text-xs text-white/45">0 = infinite loop</div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Output Formats</div>
                  <div className="flex flex-col gap-2">
                    {['webp', 'apng', 'gif'].map((format) => (
                      <div key={format} className="flex items-center space-x-2">
                        <Checkbox
                          id={format}
                          checked={formats.includes(format)}
                          onCheckedChange={() => toggleFormat(format)}
                        />
                        <Label htmlFor={format} className="text-sm font-normal cursor-pointer">
                          {format.toUpperCase()}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Compression</div>
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="local-compression"
                      checked={useLocalCompression}
                      onCheckedChange={(checked) => setUseLocalCompression(checked === true)}
                    />
                    <Label htmlFor="local-compression" className="text-sm font-normal cursor-pointer">
                      Use Local Compression
                    </Label>
                  </div>
                  {useLocalCompression && (
                    <div className="space-y-2">
                      <div className="text-sm font-semibold">Compression Quality (1-100)</div>
                      <Input
                        value={compressionQuality}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9]/g, '')
                          const num = Number(v)
                          if (num >= 1 && num <= 100) setCompressionQuality(v)
                        }}
                        placeholder="80"
                      />
                      <div className="text-xs text-white/45">Higher = better quality, larger file</div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div {...fadeUp} className="w-full">
            <Card className="bg-white/[0.03]">
              <CardHeader className="flex-row items-start justify-between gap-6 space-y-0">
                <div className="min-w-0 flex flex-col space-y-1.5">
                  <CardTitle className="flex items-center gap-2">
                    <Play className="h-5 w-5 opacity-70" />
                    Convert
                  </CardTitle>
                  <CardDescription>Start conversion process</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className={canConvert ? 'cta-pill-wrap w-full' : 'w-full'}>
                  {canConvert ? (
                    <button className="cta-plain cta-pill transition-opacity" disabled={!canConvert} onClick={startConvert} type="button">
                      <Play className="h-5 w-5" />
                      {isConverting ? 'Converting...' : 'Convert'}
                    </button>
                  ) : (
                    <Button className="h-16 w-full text-lg font-semibold bg-white/10 text-white/45 hover:bg-white/10" disabled>
                      <Play className="h-5 w-5" />
                      Convert
                    </Button>
                  )}
                </div>

                {isConverting && (
                  <div className="rounded-md bg-white/5 p-4 text-sm space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {!isPaused && <div className="h-4 w-4 border-2 border-white/30 border-t-[#55B2F9] rounded-full animate-spin" />}
                        {isPaused && <Pause className="h-4 w-4 text-yellow-500" />}
                        <span className="font-semibold">
                          {isPaused ? 'Paused' : (progress ? progress.phase : 'Starting conversion...')}
                          {progress?.format && <span className="ml-2 text-white/45">({progress.format})</span>}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={togglePause}
                          className="px-3 py-1 rounded bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 text-xs font-medium transition-colors"
                        >
                          {isPaused ? <><Play className="h-3 w-3 inline mr-1" />Resume</> : <><Pause className="h-3 w-3 inline mr-1" />Pause</>}
                        </button>
                        <button
                          onClick={cancelConvert}
                          className="px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs font-medium transition-colors"
                        >
                          <Square className="h-3 w-3 inline mr-1" />Cancel
                        </button>
                      </div>
                    </div>
                    {progress && (
                      <div className="space-y-1">
                        <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-[#55B2F9] transition-all duration-100"
                            style={{ width: `${Math.min(progress.percent || 0, 100)}%` }}
                          />
                        </div>
                        <div className="text-xs text-white/45 text-right">
                          <span className="text-white/80 font-medium">{Math.round(progress.percent || 0)}%</span>
                          {progress.total > 0 && <span className="ml-2">({progress.current} / {progress.total})</span>}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {results.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-sm font-semibold">Results:</div>
                    {results.map((result, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded-md bg-white/5 p-3 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          {result.success ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                          ) : (
                            <XCircle className="h-4 w-4 text-red-500" />
                          )}
                          <span className="font-semibold">{result.format.toUpperCase()}</span>
                          <span className="text-white/60 truncate">{result.path}</span>
                        </div>
                        {result.success && result.originalSize && (
                          <div className="text-xs text-white/45">
                            {result.compressedSize ? (
                              <>
                                {((result.compressedSize / result.originalSize) * 100).toFixed(1)}% of original
                              </>
                            ) : (
                              <>{(result.originalSize / 1024).toFixed(1)} KB</>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>
    </div>
  )
}
